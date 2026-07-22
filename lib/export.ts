import type { DiagramColors } from 'beautiful-mermaid'
import { colorsToCssVars, renderThemeableSVG, resolveThemeVariables } from './mermaid'
import { parseColor, toHex } from './color'

/**
 * Export pipeline. Both exporters (SVG / PNG) reuse a single
 * "resolve theme into a standalone SVG" step.
 *
 * Why this is needed (the classic gotcha): beautiful-mermaid colors elements
 * with CSS custom properties derived via `color-mix()`. Those resolve live in
 * the browser from properties set on a parent, but a *downloaded* file has no
 * such parent, so it renders colorless. We therefore render offscreen with the
 * theme applied, read each element's browser-*computed* color, and inline the
 * literal value onto the element. The browser is the source of truth; a
 * hand-rolled color-mix reproduction (lib/mermaid.ts) is used only as a fallback.
 */

/** A web-safe stack used for exports: renders identically offline and in canvas
 *  without needing to embed or fetch a webfont. */
const EXPORT_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const COLOR_ATTRS: Array<{ attr: string; cssProp: 'fill' | 'stroke' | 'stopColor' | 'color' }> = [
  { attr: 'fill', cssProp: 'fill' },
  { attr: 'stroke', cssProp: 'stroke' },
  { attr: 'stop-color', cssProp: 'stopColor' },
  { attr: 'color', cssProp: 'color' },
]

/**
 * Element types that actually paint. Some diagrams (notably xychart) color their
 * text/bars/lines exclusively through `<style>` class rules — `.xychart-title {
 * fill: var(--_text) }` — with no per-element color attribute. Those rules are
 * discarded by `cleanStyleBlock`, so we must first read the browser-computed
 * fill/stroke off these shapes and inline it. Restricting to painting tags avoids
 * slapping a default black fill onto structural wrappers (`<g>`, `<svg>`).
 */
const PAINT_TAGS = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polygon',
  'polyline',
  'text',
  'tspan',
  'stop',
])

/**
 * Non-color presentation properties the same class rules set (bar/line widths,
 * grid-dot and line-shadow opacity, dash patterns). Lost with the style block
 * unless inlined, which would leave hairline strokes and full-opacity dots in the
 * export. Inlined verbatim (units stripped) since they carry no CSS variables.
 */
const GEOMETRY_PROPS = [
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
] as const

export interface StandaloneSvg {
  /** The fully self-contained SVG markup (literal colors, no external refs). */
  markup: string
  width: number
  height: number
}

interface ResolveOptions {
  /** Paint the theme background behind the diagram. */
  paintBackground: boolean
}

/**
 * Render the diagram, mount it offscreen with `colors` applied, and inline every
 * computed color so the result stands alone. Runs a caller-supplied function
 * with the *attached, resolved* SVG element (needed so computed styles and
 * layout can be read from the live DOM), then always cleans up.
 */
async function withResolvedSvg<T>(
  text: string,
  colors: DiagramColors,
  opts: ResolveOptions,
  use: (svg: SVGSVGElement, dims: { width: number; height: number }) => T | Promise<T>,
): Promise<T> {
  // Render in CSS-variable mode; attributes reference var(--_*).
  const raw = renderThemeableSVG(text)

  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  // Mount far offscreen but at NATURAL size — NOT clipped to 0×0, so getBBox/CTM
  // report real geometry and computed styles resolve against a laid-out tree.
  host.style.cssText = 'position:fixed;left:-99999px;top:0;pointer-events:none;'
  // Base palette lives on the host so the SVG's derived color-mix resolves.
  // NOTE: custom properties must go through setProperty — assigning them onto
  // the CSSStyleDeclaration (e.g. Object.assign / host.style['--x']=…) is a
  // silent no-op, which would leave --mm-bg/--mm-fg unset and collapse every
  // fg-derived color to its initial (black) in the export.
  for (const [prop, value] of Object.entries(colorsToCssVars(colors))) {
    host.style.setProperty(prop, value)
  }
  host.innerHTML = raw
  document.body.appendChild(host)

  try {
    const svg = host.querySelector('svg')
    if (!svg) throw new Error('Renderer produced no <svg> element.')

    const width = parseFloat(svg.getAttribute('width') ?? '0') || 0
    const height = parseFloat(svg.getAttribute('height') ?? '0') || 0

    inlineComputedColors(svg, colors)
    cleanStyleBlock(svg)
    svg.removeAttribute('style') // drop leftover --bg/--fg custom props
    if (opts.paintBackground) prependBackground(svg, colors.bg, width, height)
    ensureNamespaces(svg)

    return await use(svg, { width, height })
  } finally {
    host.remove()
  }
}

/**
 * Inline every color that resolves live in the browser but wouldn't survive in a
 * standalone file: colors referenced through a `var(...)` attribute (every
 * diagram type) AND colors applied purely via `<style>` class rules on painting
 * shapes/text (xychart), which the subsequent `cleanStyleBlock` would discard.
 * Also inlines the non-color presentation props those rules set so geometry and
 * opacity are preserved.
 */
function inlineComputedColors(svg: SVGSVGElement, colors: DiagramColors): void {
  const fallback = resolveThemeVariables(colors)
  const elements = [svg, ...Array.from(svg.querySelectorAll('*'))] as Element[]
  for (const el of elements) {
    const computed =
      el instanceof SVGElement || el instanceof HTMLElement
        ? getComputedStyle(el)
        : null
    const paints = PAINT_TAGS.has(el.tagName.toLowerCase())

    for (const { attr, cssProp } of COLOR_ATTRS) {
      const value = el.getAttribute(attr)
      const viaVar = !!value && value.includes('var(')
      // Class-rule fills/strokes only need harvesting on shapes/text; stop-color
      // and `color` still travel through var() attributes when present.
      const viaClass = paints && (attr === 'fill' || attr === 'stroke')
      if (!viaVar && !viaClass) continue

      const resolved = computed?.[cssProp]?.trim()
      if (resolved && resolved !== '' && resolved !== 'rgba(0, 0, 0, 0)') {
        // Reduce to a concrete, standalone-safe color. getComputedStyle can hand
        // back modern syntax the exported file's viewer may not resolve —
        // notably `color-mix()` (xychart bar fills) — which then paints black.
        // Non-colors (`none`, `url(#…)`) return null and pass through untouched.
        el.setAttribute(attr, toConcreteColor(resolved) ?? resolved)
      } else if (viaVar) {
        el.setAttribute(attr, resolveViaFallback(value, fallback))
      }
    }

    if (paints && computed) {
      for (const prop of GEOMETRY_PROPS) {
        const resolved = computed.getPropertyValue(prop).trim()
        if (resolved && resolved !== 'none') {
          el.setAttribute(prop, resolved.replace(/px/g, ''))
        }
      }
    }
  }
}

let normalizeCtx: CanvasRenderingContext2D | null | undefined

/**
 * Collapse any browser-computed color string into a concrete, standalone-safe
 * value (`#rrggbb` or `rgba(...)`). The canvas 2D context resolves every CSS
 * color the browser understands — rgb/rgba, hex, `color-mix()`, `oklab/oklch`,
 * `color()` — down to a literal, so nothing that needs a live document (a CSS
 * variable, a `color-mix`) leaks into the exported file and renders black.
 * Returns null for non-colors (`none`, `url(#…)`) and anything unparseable.
 */
function toConcreteColor(input: string): string | null {
  const s = input.trim()
  if (!s || s === 'none' || s.startsWith('url(')) return null
  if (normalizeCtx === undefined) {
    normalizeCtx = document.createElement('canvas').getContext('2d')
  }
  if (normalizeCtx) {
    // A value the canvas rejects leaves fillStyle untouched, so probe against
    // two different sentinels: equal results mean the input parsed cleanly.
    normalizeCtx.fillStyle = '#000000'
    normalizeCtx.fillStyle = s
    const a = normalizeCtx.fillStyle
    normalizeCtx.fillStyle = '#ffffff'
    normalizeCtx.fillStyle = s
    if (a === normalizeCtx.fillStyle) return a
  }
  // Fallback parser (drops alpha) — still better than a value that can't resolve.
  const rgb = parseColor(s)
  return rgb ? toHex(rgb) : null
}

/** Resolve a raw `var(--name, fallback)` string using the JS color map. */
function resolveViaFallback(value: string, map: Record<string, string>): string {
  const match = value.match(/var\((--[\w-]+)/)
  if (match && map[match[1]!]) return map[match[1]!]!
  return value
}

/** Strip the external font @import and the CSS-variable definitions (colors are
 *  now inlined), keeping only a self-contained font declaration. */
function cleanStyleBlock(svg: SVGSVGElement): void {
  const style = svg.querySelector('style')
  if (style) {
    style.textContent = `text { font-family: ${EXPORT_FONT_STACK}; }`
  }
  // Also set font on text nodes directly so var-unaware renderers obey.
  svg.querySelectorAll('text, tspan').forEach((t) => {
    if (!t.getAttribute('font-family')) t.setAttribute('font-family', EXPORT_FONT_STACK)
  })
}

function prependBackground(svg: SVGSVGElement, bg: string, w: number, h: number): void {
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  rect.setAttribute('x', '0')
  rect.setAttribute('y', '0')
  rect.setAttribute('width', String(w))
  rect.setAttribute('height', String(h))
  rect.setAttribute('fill', bg)
  svg.insertBefore(rect, svg.firstChild)
}

function ensureNamespaces(svg: SVGSVGElement): void {
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  if (!svg.getAttribute('xmlns:xlink'))
    svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
}

/** The shared step: produce a standalone SVG string + its pixel dimensions. */
export async function resolveStandaloneSvg(
  text: string,
  colors: DiagramColors,
  opts: ResolveOptions,
): Promise<StandaloneSvg> {
  return withResolvedSvg(text, colors, opts, (svg, dims) => ({
    markup: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`,
    ...dims,
  }))
}

/* ------------------------------------------------------------------ */
/* Downloads                                                          */
/* ------------------------------------------------------------------ */

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function exportSVG(
  text: string,
  colors: DiagramColors,
  filename: string,
  paintBackground: boolean,
): Promise<void> {
  const { markup } = await resolveStandaloneSvg(text, colors, { paintBackground })
  triggerDownload(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), filename)
}

/** Copy the standalone SVG markup to the clipboard as text. */
export async function copySVG(
  text: string,
  colors: DiagramColors,
  paintBackground: boolean,
): Promise<void> {
  const { markup } = await resolveStandaloneSvg(text, colors, { paintBackground })
  await navigator.clipboard.writeText(markup)
}

/** Rasterize the resolved SVG to a high-DPI PNG blob (shared by download/copy). */
async function renderPngBlob(
  text: string,
  colors: DiagramColors,
  paintBackground: boolean,
): Promise<Blob> {
  const { markup, width, height } = await resolveStandaloneSvg(text, colors, {
    paintBackground,
  })

  // Ensure fonts are ready so text isn't rasterized in a fallback face.
  if (document.fonts?.ready) await document.fonts.ready

  const scale = Math.min(4, Math.max(2, Math.round(window.devicePixelRatio || 1) + 1))
  const img = new Image()
  const svgUrl = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))

  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Failed to load SVG for rasterization.'))
      img.src = svgUrl
    })

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not acquire a 2D canvas context.')
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    )
    if (!blob) throw new Error('Canvas produced no PNG blob.')
    return blob
  } finally {
    URL.revokeObjectURL(svgUrl)
  }
}

export async function exportPNG(
  text: string,
  colors: DiagramColors,
  filename: string,
  paintBackground: boolean,
): Promise<void> {
  triggerDownload(await renderPngBlob(text, colors, paintBackground), filename)
}

/** Copy the rendered PNG to the clipboard as an image. */
export async function copyPNG(
  text: string,
  colors: DiagramColors,
  paintBackground: boolean,
): Promise<void> {
  const blob = await renderPngBlob(text, colors, paintBackground)
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
}
