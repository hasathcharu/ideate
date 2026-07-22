import type { DiagramColors } from 'beautiful-mermaid'
import { colorsToCssVars, renderThemeableSVG, resolveThemeVariables } from './mermaid'
import { parseColor, toHex } from './color'

/**
 * Export pipeline. All three exporters (SVG / PNG / PDF) reuse a single
 * "resolve theme into a standalone SVG" step.
 *
 * Why this is needed (the classic gotcha): beautiful-mermaid colors elements
 * with CSS custom properties derived via `color-mix()`. Those resolve live in
 * the browser from properties set on a parent, but a *downloaded* file — or
 * svg2pdf, which understands neither CSS variables nor color-mix — has no such
 * parent, so it renders colorless. We therefore render offscreen with the theme
 * applied, read each element's browser-*computed* color, and inline the literal
 * value onto the element. The browser is the source of truth; a hand-rolled
 * color-mix reproduction (lib/mermaid.ts) is used only as a fallback.
 */

/** A web-safe stack used for exports: renders identically offline, in canvas,
 *  and in svg2pdf without needing to embed or fetch a webfont. */
const EXPORT_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const COLOR_ATTRS: Array<{ attr: string; cssProp: 'fill' | 'stroke' | 'stopColor' | 'color' }> = [
  { attr: 'fill', cssProp: 'fill' },
  { attr: 'stroke', cssProp: 'stroke' },
  { attr: 'stop-color', cssProp: 'stopColor' },
  { attr: 'color', cssProp: 'color' },
]

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
 * with the *attached, resolved* SVG element (needed by svg2pdf, which measures
 * layout via the live DOM), then always cleans up.
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
  // Mount far offscreen but at NATURAL size — NOT clipped to 0×0. svg2pdf reads
  // stroke geometry from the live DOM (getBBox/CTM); a 0×0 clipped host makes
  // stroked shapes (boxes, lines) collapse to nothing in the PDF while text
  // (positioned by x/y) survives. Full layout keeps vector strokes intact.
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

/** Replace every `var(...)`-based color attribute with its computed literal. */
function inlineComputedColors(svg: SVGSVGElement, colors: DiagramColors): void {
  const fallback = resolveThemeVariables(colors)
  const elements = [svg, ...Array.from(svg.querySelectorAll('*'))] as Element[]
  for (const el of elements) {
    const computed =
      el instanceof SVGElement || el instanceof HTMLElement
        ? getComputedStyle(el)
        : null
    for (const { attr, cssProp } of COLOR_ATTRS) {
      const value = el.getAttribute(attr)
      if (!value || !value.includes('var(')) continue
      const resolved = computed?.[cssProp]
      if (resolved && resolved !== '' && resolved !== 'rgba(0, 0, 0, 0)') {
        // Normalize to #rrggbb. getComputedStyle may return rgb()/rgba() or a
        // newer color syntax; svg2pdf (PDF export) only reliably parses hex, so
        // hex keeps SVG, PNG and PDF consistent.
        const rgb = parseColor(resolved)
        el.setAttribute(attr, rgb ? toHex(rgb) : resolved)
      } else {
        el.setAttribute(attr, resolveViaFallback(value, fallback))
      }
    }
  }
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
  // Also set font on text nodes directly so var-unaware renderers (svg2pdf) obey.
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

/**
 * PDF export — true vector via svg2pdf. The offscreen SVG is mounted at natural
 * size (see withResolvedSvg) so svg2pdf can measure stroke geometry and keep
 * entity boxes / relationship lines, and every color is inlined as literal hex
 * beforehand (svg2pdf understands neither CSS variables nor color-mix).
 */
export async function exportPDF(
  text: string,
  colors: DiagramColors,
  filename: string,
  paintBackground: boolean,
): Promise<void> {
  const [{ jsPDF }, svg2pdfMod] = await Promise.all([import('jspdf'), import('svg2pdf.js')])
  const svg2pdf = svg2pdfMod.svg2pdf

  await withResolvedSvg(text, colors, { paintBackground }, async (svg, { width, height }) => {
    const pdf = new jsPDF({
      unit: 'pt',
      format: [width, height],
      orientation: width >= height ? 'landscape' : 'portrait',
    })
    await svg2pdf(svg, pdf, { x: 0, y: 0, width, height })
    pdf.save(filename)
  })
}
