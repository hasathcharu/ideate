import { renderToSvg } from './mermaid'
import type { MermaidUserConfig } from './mermaidConfig'

/**
 * Export pipeline. Both exporters (SVG / PNG) reuse a single "render into a
 * standalone SVG" step.
 *
 * Official mermaid bakes literal colors and a self-contained `<style>` block into
 * the SVG at render time, so — unlike the previous CSS-variable renderer — the
 * markup already stands alone. We only normalize dimensions, add the XML
 * namespaces, and optionally paint a background.
 */

/** mermaid's `default` theme paints on white. */
const BACKGROUND = '#ffffff'

export interface StandaloneSvg {
  /** The fully self-contained SVG markup (literal colors, no external refs). */
  markup: string
  width: number
  height: number
}

interface ResolveOptions {
  /** Paint a solid background behind the diagram (vs. transparent). */
  paintBackground: boolean
  /** Global mermaid config (theme, layout, per-diagram settings) to render with. */
  config?: MermaidUserConfig | null
}

/** Read the diagram's intrinsic pixel size from width/height, falling back to
 *  the viewBox (mermaid emits `width="100%"` + a viewBox). */
function intrinsicSize(svg: SVGSVGElement): { width: number; height: number } {
  const vb = svg.viewBox?.baseVal
  let width = parseFloat(svg.getAttribute('width') ?? '')
  let height = parseFloat(svg.getAttribute('height') ?? '')
  if ((!width || !height) && vb && vb.width && vb.height) {
    width = vb.width
    height = vb.height
  }
  return { width: width || 0, height: height || 0 }
}

/** The shared step: produce a standalone SVG string + its pixel dimensions. */
export async function resolveStandaloneSvg(
  text: string,
  opts: ResolveOptions,
): Promise<StandaloneSvg> {
  const raw = await renderToSvg(text, opts.config ?? null)

  // Parse via the HTML parser, not `DOMParser(..., 'image/svg+xml')`. Note/label
  // text renders through a `<foreignObject>` with real HTML inside (e.g. `<br>`
  // for line breaks) regardless of `flowchart.htmlLabels` — valid HTML, but not
  // well-formed XML. Strict XML parsing hits that on the first multi-line note
  // and silently truncates the document from there on (browsers recover from
  // `image/svg+xml` parse errors by rendering only the content up to the
  // failure), which is why exports could lose content after the first note.
  // The HTML parser has spec'd foreign-content handling for embedded
  // <svg>/<foreignObject> subtrees, so this parses the same DOM Preview.tsx
  // shows on screen; XMLSerializer then always emits well-formed XML.
  const container = document.createElement('div')
  container.innerHTML = raw
  const svg = container.querySelector('svg')
  if (!svg) throw new Error('Renderer produced no <svg> element.')

  const { width, height } = intrinsicSize(svg)

  // Pin explicit pixel dimensions (mermaid uses width="100%") so the file and
  // the raster canvas both size correctly.
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.style.removeProperty('max-width')

  ensureNamespaces(svg)
  if (opts.paintBackground) prependBackground(svg, BACKGROUND, width, height)

  const markup = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`
  return { markup, width, height }
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
  filename: string,
  paintBackground: boolean,
  config?: MermaidUserConfig | null,
): Promise<void> {
  const { markup } = await resolveStandaloneSvg(text, { paintBackground, config })
  triggerDownload(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), filename)
}

/** Copy the standalone SVG markup to the clipboard as text. */
export async function copySVG(
  text: string,
  paintBackground: boolean,
  config?: MermaidUserConfig | null,
): Promise<void> {
  const { markup } = await resolveStandaloneSvg(text, { paintBackground, config })
  await navigator.clipboard.writeText(markup)
}

/** Rasterize the resolved SVG to a high-DPI PNG blob (shared by download/copy). */
async function renderPngBlob(
  text: string,
  paintBackground: boolean,
  config?: MermaidUserConfig | null,
): Promise<Blob> {
  const { markup, width, height } = await resolveStandaloneSvg(text, { paintBackground, config })

  // Ensure fonts are ready so text isn't rasterized in a fallback face.
  if (document.fonts?.ready) await document.fonts.ready

  const scale = Math.min(4, Math.max(2, Math.round(window.devicePixelRatio || 1) + 1))
  const img = new Image()
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`

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
}

export async function exportPNG(
  text: string,
  filename: string,
  paintBackground: boolean,
  config?: MermaidUserConfig | null,
): Promise<void> {
  triggerDownload(await renderPngBlob(text, paintBackground, config), filename)
}

/** Copy the rendered PNG to the clipboard as an image. */
export async function copyPNG(
  text: string,
  paintBackground: boolean,
  config?: MermaidUserConfig | null,
): Promise<void> {
  const blob = await renderPngBlob(text, paintBackground, config)
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
}
