import { renderToSvg } from './mermaid'
import { buildExportSource } from './mermaidConfig'
import type { MermaidUserConfig } from './mermaidConfig'
import type { ExportBackground } from './types'

/**
 * Export pipeline. Both exporters (SVG / PNG) reuse a single "render into a
 * standalone SVG" step.
 *
 * Official mermaid bakes literal colors and a self-contained `<style>` block into
 * the SVG at render time, so — unlike the previous CSS-variable renderer — the
 * markup already stands alone. We only normalize dimensions, add the XML
 * namespaces, and optionally paint a background.
 */

export interface StandaloneSvg {
  /** The fully self-contained SVG markup (literal colors, no external refs). */
  markup: string
  width: number
  height: number
}

interface ResolveOptions {
  /** Background to paint behind the diagram. */
  background: ExportBackground
  /** Global mermaid config (theme, layout, per-diagram settings) to render with. */
  config?: MermaidUserConfig | null
}

/** Resolve a background choice to a literal fill color, or `null` for
 *  transparent. "theme" reads the active theme's own `background` variable,
 *  falling back to white when no theme (or no `background` key) is set. */
function resolveBackgroundColor(
  background: ExportBackground,
  config?: MermaidUserConfig | null,
): string | null {
  switch (background) {
    case 'white':
      return '#ffffff'
    case 'black':
      return '#000000'
    case 'none':
      return null
    case 'theme': {
      const themeBg = config?.themeVariables?.background
      return typeof themeBg === 'string' && themeBg.trim() ? themeBg : '#ffffff'
    }
  }
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
  const bgColor = resolveBackgroundColor(opts.background, opts.config)
  if (bgColor) prependBackground(svg, bgColor, width, height)

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
/* Rasterization scale                                                 */
/* ------------------------------------------------------------------ */

/** Never rasterize below this multiplier, so large diagrams still come out at
 *  better-than-retina density. */
const MIN_RASTER_SCALE = 3
/** Ceiling on the multiplier, so a tiny drawing doesn't get blown up absurdly. */
const MAX_RASTER_SCALE = 10
/** Grow small diagrams until their longest edge reaches this, in pixels. */
const TARGET_LONG_EDGE = 2400
/** Hard cap per side. Browsers refuse to allocate canvases beyond a few thousand
 *  pixels (Safari is the strictest), and an over-large request fails outright
 *  rather than degrading, so stay well inside it. */
const MAX_RASTER_DIMENSION = 8192

/**
 * Pixel multiplier for rasterizing a diagram of `width` × `height` to PNG.
 *
 * A flat device-pixel-ratio multiplier isn't enough on its own: it makes output
 * density proportional to the *diagram's* size, so a small diagram lands in a
 * correspondingly small image — which is what usually reads as a "low quality"
 * export. Scaling toward a target long edge fixes exactly that case, while the
 * floor keeps big diagrams dense and the dimension cap keeps the canvas
 * allocatable.
 */
export function rasterScale(width: number, height: number): number {
  const longest = Math.max(width, height)
  if (!longest || !Number.isFinite(longest)) return MIN_RASTER_SCALE
  const toTarget = TARGET_LONG_EDGE / longest
  const dimensionCap = MAX_RASTER_DIMENSION / longest
  return Math.min(MAX_RASTER_SCALE, dimensionCap, Math.max(MIN_RASTER_SCALE, toTarget))
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
  background: ExportBackground,
  config?: MermaidUserConfig | null,
): Promise<void> {
  const { markup } = await resolveStandaloneSvg(text, { background, config })
  triggerDownload(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), filename)
}

/** Copy the standalone SVG markup to the clipboard as text. */
export async function copySVG(
  text: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
): Promise<void> {
  const { markup } = await resolveStandaloneSvg(text, { background, config })
  await navigator.clipboard.writeText(markup)
}

/** Rasterize the resolved SVG to a high-DPI PNG blob (shared by download/copy). */
async function renderPngBlob(
  text: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
): Promise<Blob> {
  const { markup, width, height } = await resolveStandaloneSvg(text, { background, config })

  // Ensure fonts are ready so text isn't rasterized in a fallback face.
  if (document.fonts?.ready) await document.fonts.ready

  const scale = rasterScale(width, height)
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
  // Derive the transform from the rounded canvas size rather than reusing `scale`,
  // which is now fractional — otherwise the rounding leaves a sub-pixel gap at the
  // right/bottom edges.
  ctx.scale(canvas.width / width, canvas.height / height)
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
  background: ExportBackground,
  config?: MermaidUserConfig | null,
): Promise<void> {
  triggerDownload(await renderPngBlob(text, background, config), filename)
}

/** Copy the rendered PNG to the clipboard as an image. */
export async function copyPNG(
  text: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
): Promise<void> {
  const blob = await renderPngBlob(text, background, config)
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
}

/* ------------------------------------------------------------------ */
/* Mermaid source (code + config)                                      */
/* ------------------------------------------------------------------ */

/** Download the raw mermaid diagram source, with the global config baked in as
 *  a YAML frontmatter block, as a standalone `.mmd` file. */
export async function exportSource(
  text: string,
  filename: string,
  configYaml: string,
): Promise<void> {
  const source = buildExportSource(text, configYaml)
  triggerDownload(new Blob([source], { type: 'text/plain;charset=utf-8' }), filename)
}

/** Copy the raw mermaid diagram source (with config frontmatter) to the clipboard. */
export async function copySource(text: string, configYaml: string): Promise<void> {
  await navigator.clipboard.writeText(buildExportSource(text, configYaml))
}
