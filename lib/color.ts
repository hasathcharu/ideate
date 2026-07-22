/**
 * Minimal sRGB color math used to resolve beautiful-mermaid's CSS `color-mix()`
 * derivations into concrete hex values for export.
 *
 * beautiful-mermaid renders SVGs whose colors are CSS custom properties derived
 * from a small palette via `color-mix(in srgb, <fg> N%, <bg>)`. Browsers resolve
 * these live, but a downloaded SVG (or svg2pdf, which ignores CSS variables and
 * color-mix) needs the final literal colors. This module reproduces that math.
 */

export interface RGB {
  r: number
  g: number
  b: number
}

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa` (alpha ignored) or `rgb()/rgba()`. */
export function parseColor(input: string): RGB | null {
  const s = input.trim()

  if (s.startsWith('#')) {
    const hex = s.slice(1)
    if (hex.length === 3) {
      const r = hex[0]!
      const g = hex[1]!
      const b = hex[2]!
      return {
        r: parseInt(r + r, 16),
        g: parseInt(g + g, 16),
        b: parseInt(b + b, 16),
      }
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      }
    }
    return null
  }

  const rgbMatch = s.match(/^rgba?\(([^)]+)\)$/i)
  if (rgbMatch) {
    const parts = rgbMatch[1]!.split(/[,/\s]+/).filter(Boolean)
    if (parts.length >= 3) {
      const r = channelFromString(parts[0]!)
      const g = channelFromString(parts[1]!)
      const b = channelFromString(parts[2]!)
      if (r !== null && g !== null && b !== null) return { r, g, b }
    }
  }

  return null
}

function channelFromString(v: string): number | null {
  const n = v.endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v)
  if (Number.isNaN(n)) return null
  return clampByte(n)
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

export function toHex({ r, g, b }: RGB): string {
  const h = (n: number) => clampByte(n).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/**
 * Equivalent of CSS `color-mix(in srgb, a <pctA>%, b)`.
 * The second color implicitly takes the remaining weight, mixed in the
 * gamma-encoded sRGB space (matching browsers for the `in srgb` keyword).
 */
export function mixSrgb(a: RGB, b: RGB, pctA: number): RGB {
  const wa = pctA / 100
  const wb = 1 - wa
  return {
    r: a.r * wa + b.r * wb,
    g: a.g * wa + b.g * wb,
    b: a.b * wa + b.b * wb,
  }
}
