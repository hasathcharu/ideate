import { renderToSvg } from './mermaid'
import { buildExportSource, themeFromConfig } from './mermaidConfig'
import type { MermaidUserConfig } from './mermaidConfig'
import { THEME_PRESETS, type ThemePreset } from './themes'
import type { ExportBackground, PngScale, SvgThemeMode } from './types'

/** Export pipeline. Both exporters (SVG / PNG) reuse a single "render into a standalone SVG" step. */

export interface StandaloneSvg {
  /** The fully self-contained SVG markup (literal colors, no external refs). */
  markup: string
  width: number
  height: number
}

export interface ResolveOptions {
  /** Background to paint behind the diagram. */
  background: ExportBackground
  /** Global mermaid config (theme, layout, per-diagram settings) to render with. */
  config?: MermaidUserConfig | null
  /** SVG-only palette behavior. PNG always uses the configured palette. */
  themeMode?: SvgThemeMode
  /** Add a 24px frame whose background has rounded corners. */
  framed?: boolean
}

const EXPORT_PADDING = 24
const EXPORT_RADIUS = 16

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
      if (typeof themeBg === 'string' && themeBg.trim()) return themeBg
      return config?.theme === 'dark' ? '#1f2020' : '#ffffff'
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
  if (opts.themeMode === 'dynamic') return resolveDynamicSvg(text, opts)
  return resolveSvgVariant(text, opts)
}

async function resolveSvgVariant(text: string, opts: ResolveOptions): Promise<StandaloneSvg> {
  const raw = await renderToSvg(text, opts.config ?? null)

  // Parse via the HTML parser, not `DOMParser(..., 'image/svg+xml')`.
  const container = document.createElement('div')
  container.innerHTML = raw
  const svg = container.querySelector('svg')
  if (!svg) throw new Error('Renderer produced no <svg> element.')

  const intrinsic = intrinsicSize(svg)
  const bounds = measureExportBounds(svg, intrinsic.width, intrinsic.height)
  const pad = opts.framed ? EXPORT_PADDING : 0
  const x = bounds.x - pad
  const y = bounds.y - pad
  const width = bounds.width + pad * 2
  const height = bounds.height + pad * 2

  // Pin explicit pixel dimensions (mermaid uses width="100%") so the file and
  // the raster canvas both size correctly.
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`)
  svg.style.removeProperty('max-width')

  ensureNamespaces(svg)
  const bgColor = resolveBackgroundColor(opts.background, opts.config)
  if (bgColor) prependBackground(svg, bgColor, x, y, width, height, opts.framed)

  const markup = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`
  return { markup, width, height }
}

/** Include painted content that Mermaid left outside its declared viewBox (most
 * commonly a long sequence-message label). */
function measureExportBounds(
  svg: SVGSVGElement,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const vb = svg.viewBox?.baseVal
  const base = {
    x: vb?.x ?? 0,
    y: vb?.y ?? 0,
    width: vb?.width || width,
    height: vb?.height || height,
  }
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none'
  document.body.appendChild(host)
  host.appendChild(svg)
  try {
    const painted = svg.getBBox()
    if (![painted.x, painted.y, painted.width, painted.height].every(Number.isFinite)) return base
    const left = Math.min(base.x, painted.x)
    const top = Math.min(base.y, painted.y)
    const right = Math.max(base.x + base.width, painted.x + painted.width)
    const bottom = Math.max(base.y + base.height, painted.y + painted.height)
    return { x: left, y: top, width: right - left, height: bottom - top }
  } catch {
    return base
  } finally {
    host.remove()
  }
}

function prependBackground(
  svg: SVGSVGElement,
  bg: string,
  x: number,
  y: number,
  w: number,
  h: number,
  rounded = false,
): void {
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  rect.setAttribute('x', String(x))
  rect.setAttribute('y', String(y))
  rect.setAttribute('width', String(w))
  rect.setAttribute('height', String(h))
  rect.setAttribute('fill', bg)
  if (rounded) {
    rect.setAttribute('rx', String(EXPORT_RADIUS))
    rect.setAttribute('ry', String(EXPORT_RADIUS))
  }
  svg.insertBefore(rect, svg.firstChild)
}

async function resolveDynamicSvg(text: string, opts: ResolveOptions): Promise<StandaloneSvg> {
  const { light: lightConfig, dark: darkConfig } = resolveDynamicThemeConfigs(opts.config)
  const [light, dark] = await Promise.all([
    resolveSvgVariant(text, { ...opts, themeMode: 'forced', config: lightConfig }),
    resolveSvgVariant(text, { ...opts, themeMode: 'forced', config: darkConfig }),
  ])
  const width = Math.max(light.width, dark.width)
  const height = Math.max(light.height, dark.height)
  const lightNode = parseSvgMarkup(light.markup)
  const darkNode = parseSvgMarkup(dark.markup)
  lightNode.setAttribute('class', 'km-light')
  darkNode.setAttribute('class', 'km-dark')
  lightNode.setAttribute('width', '100%')
  lightNode.setAttribute('height', '100%')
  darkNode.setAttribute('width', '100%')
  darkNode.setAttribute('height', '100%')

  const root = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  root.setAttribute('viewBox', `0 0 ${width} ${height}`)
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style')
  style.textContent = '.km-dark{display:none}@media(prefers-color-scheme:dark){.km-light{display:none}.km-dark{display:inline}}'
  root.append(style, lightNode, darkNode)
  return {
    markup: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(root)}`,
    width,
    height,
  }
}

const THEME_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['zinc-light', 'zinc-dark'],
  ['tokyo-night-light', 'tokyo-night'],
  ['tokyo-night-light', 'tokyo-night-storm'],
  ['catppuccin-latte', 'catppuccin-mocha'],
  ['nord-light', 'nord'],
  ['github-light', 'github-dark'],
  ['solarized-light', 'solarized-dark'],
  ['gruvbox-light', 'gruvbox-dark'],
  ['rose-pine-dawn', 'rose-pine'],
]

/** Preserve a known palette family across a dynamic SVG's light/dark variants. */
export function resolveDynamicThemeConfigs(
  config: MermaidUserConfig | null | undefined,
): { light: MermaidUserConfig; dark: MermaidUserConfig } {
  const active = themeFromConfig(config ?? null)
  const pair = active
    ? THEME_PAIRS.find(([light, dark]) => light === active.value || dark === active.value)
    : undefined
  const light = pair ? THEME_PRESETS.find((preset) => preset.value === pair[0]) : undefined
  const dark = pair ? THEME_PRESETS.find((preset) => preset.value === pair[1]) : undefined
  return {
    light: dynamicThemeConfig(config, 'default', light),
    dark: dynamicThemeConfig(config, 'dark', dark),
  }
}

function dynamicThemeConfig(
  config: MermaidUserConfig | null | undefined,
  fallbackTheme: 'default' | 'dark',
  preset?: ThemePreset,
): MermaidUserConfig {
  if (preset) {
    return { ...(config ?? {}), theme: preset.theme, themeVariables: { ...preset.themeVariables } }
  }
  const next: MermaidUserConfig = { ...(config ?? {}), theme: fallbackTheme }
  delete next.themeVariables
  return next
}

function parseSvgMarkup(markup: string): SVGSVGElement {
  const host = document.createElement('div')
  host.innerHTML = markup.replace(/^<\?xml[^>]*>\s*/, '')
  const svg = host.querySelector('svg')
  if (!svg) throw new Error('Renderer produced no <svg> element.')
  return svg
}

function ensureNamespaces(svg: SVGSVGElement): void {
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  if (!svg.getAttribute('xmlns:xlink'))
    svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
}

/* ------------------------------------------------------------------ */
/* Rasterization scale                                                 */
/* ------------------------------------------------------------------ */

/** Used only as a safe fallback for an invalid programmatic request. */
const MIN_RASTER_SCALE = 3
/** Ceiling on the multiplier, so a tiny drawing doesn't get blown up absurdly. */
const MAX_RASTER_SCALE = 10
/** Grow small diagrams until their longest edge reaches this, in pixels. */
const TARGET_LONG_EDGE = 2400
/** Hard cap per side. Browsers refuse to allocate canvases beyond a few thousand
 *  pixels (Safari is the strictest), and an over-large request fails outright
 *  rather than degrading, so stay well inside it. */
const MAX_RASTER_DIMENSION = 8192

/** Pixel multiplier for rasterizing a diagram of `width` × `height` to PNG. */
export function rasterScale(width: number, height: number): number {
  const longest = Math.max(width, height)
  if (!longest || !Number.isFinite(longest)) return MIN_RASTER_SCALE
  const toTarget = TARGET_LONG_EDGE / longest
  const dimensionCap = MAX_RASTER_DIMENSION / longest
  return Math.min(MAX_RASTER_SCALE, dimensionCap, Math.max(MIN_RASTER_SCALE, toTarget))
}

/** The reference density a CSS pixel is defined against, so a requested DPI can
 *  be expressed as a multiplier of the drawing's natural size. */
export const CSS_DPI = 96

/** The default PNG density. */
export const DEFAULT_PNG_SCALE: PngScale = { mode: 'multiplier', value: 2 }

/** The pixel multiplier `spec` asks for, given a drawing of `width` × `height`. */
export function resolvePngScale(
  spec: PngScale | undefined,
  width: number,
  height: number,
): number {
  const longest = Math.max(width, height)
  const cap = longest > 0 && Number.isFinite(longest) ? MAX_RASTER_DIMENSION / longest : MAX_RASTER_SCALE
  const floor = longest > 0 && Number.isFinite(longest) ? 1 / longest : 0.01

  const raw = (() => {
    switch (spec?.mode) {
      case 'multiplier':
        return spec.value
      case 'dpi':
        return spec.value / CSS_DPI
      case 'width':
        return width > 0 ? spec.value / width : 1
      case 'height':
        return height > 0 ? spec.value / height : 1
      case undefined:
        return rasterScale(width, height)
    }
  })()

  if (!Number.isFinite(raw) || raw <= 0) return rasterScale(width, height)
  return Math.min(cap, Math.max(floor, raw))
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
  options?: Pick<ResolveOptions, 'themeMode' | 'framed'>,
): Promise<void> {
  const { markup } = await resolveStandaloneSvg(text, { background, config, ...options })
  triggerDownload(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), filename)
}

/** Copy the standalone SVG markup to the clipboard as text. */
export async function copySVG(
  text: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
  options?: Pick<ResolveOptions, 'themeMode' | 'framed'>,
): Promise<void> {
  const { markup } = await resolveStandaloneSvg(text, { background, config, ...options })
  await navigator.clipboard.writeText(markup)
}

/** Rasterize the resolved SVG to a high-DPI PNG blob (shared by download/copy). */
export async function renderPngBlob(
  text: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
  pngScale?: PngScale,
  framed = false,
): Promise<Blob> {
  const { markup, width, height } = await resolveStandaloneSvg(text, { background, config, framed })

  // Ensure fonts are ready so text isn't rasterized in a fallback face.
  if (document.fonts?.ready) await document.fonts.ready

  const scale = resolvePngScale(pngScale, width, height)
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
  pngScale?: PngScale,
  framed = false,
): Promise<void> {
  triggerDownload(await renderPngBlob(text, background, config, pngScale, framed), filename)
}

/** Copy the rendered PNG to the clipboard as an image. */
export async function copyPNG(
  text: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
  pngScale?: PngScale,
  framed = false,
): Promise<void> {
  const blob = await renderPngBlob(text, background, config, pngScale, framed)
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

/* ------------------------------------------------------------------ */
/* Markdown documents                                                  */
/* ------------------------------------------------------------------ */

/**
 * A markdown document exports as itself — there is no render step, because the file already *is*
 * the portable artifact (GitHub, and every other markdown renderer, will draw the ```mermaid fences
 * themselves).
 */

const MARKDOWN_MIME = 'text/markdown;charset=utf-8'

export async function exportMarkdownSource(text: string, filename: string): Promise<void> {
  triggerDownload(new Blob([text], { type: MARKDOWN_MIME }), filename)
}

export async function copyMarkdownSource(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}
