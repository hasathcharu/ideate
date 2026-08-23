/**
 * Color arithmetic shared by the theme pipeline.
 *
 * A mermaid `themeVariables` palette is a *diagram* palette: `primaryBorderColor`
 * is a node outline, `lineColor` an edge. `applyThemeToSite`
 * (`lib/mermaidConfig.ts`) maps those onto the app's shadcn tokens, which means
 * colors designed to be seen as 1px strokes end up carrying *text* — editor
 * keywords, comments, line numbers, button labels. A stroke that reads fine at
 * 1px against white can be at 2.3:1, which is unreadable as text.
 *
 * So the mapping runs its text tokens through {@link ensureContrast}, and that
 * needs real numbers rather than CSS `color-mix()` strings. Everything here is
 * static, notation-limited (see {@link parseRgb}) and returns the input
 * unchanged when it can't read a color — the theme pipeline is best-effort by
 * design and a hand-edited `hsl()` must degrade to "leave it alone", not throw.
 */

/** `[r, g, b]` in 0–255, or null when the notation isn't statically parseable.
 *
 *  Handles what the theme presets and hand-edited `themeVariables` realistically
 *  use: #rgb / #rgba / #rrggbb / #rrggbbaa and rgb()/rgba(). Anything else
 *  (hsl(), named colors, color-mix(), var()) returns null so the caller can fall
 *  back rather than guess. */
export function parseRgb(color: string): [number, number, number] | null {
  const value = color.trim().toLowerCase()

  const hex = value.match(/^#([0-9a-f]{3,8})$/)
  if (hex) {
    const digits = hex[1]!
    // #rgb / #rgba — each digit is a doubled nibble.
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b] = [...digits.slice(0, 3)].map((d) => parseInt(d + d, 16))
      return [r!, g!, b!]
    }
    // #rrggbb / #rrggbbaa — alpha (if present) is ignored; we only need hue/value.
    if (digits.length === 6 || digits.length === 8) {
      return [
        parseInt(digits.slice(0, 2), 16),
        parseInt(digits.slice(2, 4), 16),
        parseInt(digits.slice(4, 6), 16),
      ]
    }
    return null
  }

  const fn = value.match(/^rgba?\(([^)]+)\)$/)
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean).slice(0, 3)
    if (parts.length < 3) return null
    const channels = parts.map((part) => {
      const n = parseFloat(part)
      if (Number.isNaN(n)) return null
      // Percentages are relative to 255; bare numbers already are.
      return part.endsWith('%') ? (n / 100) * 255 : n
    })
    if (channels.some((c) => c === null)) return null
    return channels as [number, number, number]
  }

  return null
}

/** Relative luminance (WCAG 2.x) of already-parsed channels. */
export function luminanceOf(rgb: readonly [number, number, number]): number {
  // Linearize each channel out of sRGB's gamma curve, then weight by the
  // luminous efficiency of each primary.
  const linear = rgb.map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

/** Relative luminance (WCAG 2.x) of a CSS color, or null if it isn't a form we
 *  can read statically. */
export function relativeLuminance(color: string): number | null {
  const rgb = parseRgb(color)
  return rgb ? luminanceOf(rgb) : null
}

/** WCAG contrast ratio (1–21) between two already-parsed colors. */
export function contrastOf(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const la = luminanceOf(a)
  const lb = luminanceOf(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** WCAG contrast ratio between two CSS colors, or null if either is unreadable. */
export function contrastRatio(a: string, b: string): number | null {
  const ra = parseRgb(a)
  const rb = parseRgb(b)
  return ra && rb ? contrastOf(ra, rb) : null
}

function mixRgb(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  ratio: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * ratio,
    a[1] + (b[1] - a[1]) * ratio,
    a[2] + (b[2] - a[2]) * ratio,
  ]
}

/** `#rrggbb` for parsed channels. */
export function toHex(rgb: readonly [number, number, number]): string {
  return (
    '#' +
    rgb
      .map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0'))
      .join('')
  )
}

/**
 * Blend two CSS colors, statically. `ratio` is how much of `b` ends up in the
 * result. Returns null when either color isn't parseable, so the caller can fall
 * back to a CSS `color-mix()` (which the browser can resolve but we can't measure).
 */
export function mixColors(a: string, b: string, ratio: number): string | null {
  const ra = parseRgb(a)
  const rb = parseRgb(b)
  return ra && rb ? toHex(mixRgb(ra, rb, ratio)) : null
}

/** WCAG AA for normal-size text. The floor for anything the tokens put *words* in. */
export const TEXT_CONTRAST = 4.5
/** WCAG AA for UI components and graphical objects — focus rings, outlines. */
export const UI_CONTRAST = 3

/**
 * The nearest color to `color` that clears `target` contrast against every one of
 * `surfaces` — by blending it toward white or black, whichever moves it *away*
 * from the surface it fails on.
 *
 * Blending toward the achromatic extremes rather than rotating hue keeps the
 * palette's character: a blue accent stays blue, it just stops being the same
 * lightness as the paper it sits on. The search is over the blend fraction, which
 * contrast is monotonic in once the direction is fixed, so twelve bisections land
 * well inside a rounding error of the minimum viable adjustment — we lift the
 * color exactly as far as legibility requires and no further.
 *
 * Returns `color` untouched when it already passes, or when any color involved
 * isn't statically parseable.
 */
export function ensureContrast(
  color: string,
  surfaces: readonly (string | undefined)[],
  target: number,
): string {
  const fg = parseRgb(color)
  if (!fg) return color
  const backdrops = surfaces
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .map(parseRgb)
    .filter((rgb): rgb is [number, number, number] => rgb !== null)
  if (backdrops.length === 0) return color

  const worst = (candidate: readonly [number, number, number]) =>
    Math.min(...backdrops.map((bg) => contrastOf(candidate, bg)))
  if (worst(fg) >= target) return color

  // Move away from the surface we're failing against: light backdrop → darken,
  // dark backdrop → lighten. Judged on the backdrop with the least contrast,
  // since that is the one setting the requirement.
  const offender = backdrops.reduce((a, b) =>
    contrastOf(fg, a) <= contrastOf(fg, b) ? a : b,
  )
  const extreme: [number, number, number] =
    luminanceOf(offender) > luminanceOf(fg) ? [0, 0, 0] : [255, 255, 255]

  let low = 0
  let high = 1
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2
    if (worst(mixRgb(fg, extreme, mid)) >= target) high = mid
    else low = mid
  }
  return toHex(mixRgb(fg, extreme, high))
}
