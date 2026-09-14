import {
  SCENE_RENDER_FALLBACK_LONG_EDGE,
  SCENE_RENDER_LONG_EDGE,
  SCENE_RENDER_MAX_BYTES,
} from './agentProtocol'
import { parseScene } from './excalidraw'
import { isDarkColor, resolveThemeMode, themeBackgroundColor } from './mermaidConfig'
import type { MermaidUserConfig } from './mermaidConfig'
import { resolvePngScale } from './export'
import type { StandaloneSvg } from './export'
import type { ExportBackground, PngScale } from './types'

/**
 * Export pipeline for Excalidraw scenes — the counterpart to `lib/export.ts`, which handles
 * mermaid.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

interface ResolvedBackground {
  /** The exact color to composite behind the drawing, or null for transparent. */
  color: string | null
  /** Whether to render the drawing in Excalidraw's dark theme. */
  dark: boolean
}

/**
 * Resolve the chosen background into a literal color plus the theme the drawing should be rendered
 * in.
 */
function resolveBackground(
  background: ExportBackground,
  config: MermaidUserConfig | null | undefined,
  sceneBackground: string | undefined,
): ResolvedBackground {
  const sceneColor = sceneBackground ?? '#ffffff'

  let color: string | null
  switch (background) {
    case 'none':
      color = null
      break
    case 'white':
      color = '#ffffff'
      break
    case 'black':
      color = '#000000'
      break
    case 'theme':
      color = themeBackgroundColor(config ?? null) ?? sceneColor
      break
  }

  const dark =
    color === null
      ? resolveThemeMode(config ?? null) === 'dark'
      : (isDarkColor(color) ?? false)

  return { color, dark }
}

/** Parse scene text and shape it into the arguments Excalidraw's exporters take.
 *  Throws with a readable message so the caller's toast says something useful. */
function sceneExportInput(
  sceneText: string,
  background: ExportBackground,
  config: MermaidUserConfig | null | undefined,
) {
  const scene = parseScene(sceneText)
  if (!scene) throw new Error('This file is not a valid Excalidraw scene.')

  // The exporters take only live elements; soft-deleted ones would render as gaps.
  const elements = scene.elements.filter((element) => !element.isDeleted)
  if (elements.length === 0) throw new Error('This canvas is empty — nothing to export.')

  const rawBackground = scene.appState?.viewBackgroundColor
  const resolved = resolveBackground(
    background,
    config,
    typeof rawBackground === 'string' ? rawBackground : undefined,
  )

  const appState = {
    ...scene.appState,
    // Pin to 1 so resolution is decided in exactly one place per format: the
    // `scale` passed to `getDimensions` for PNG, and the natural size for SVG.
    // Left unset, `restore` defaults it to the display's devicePixelRatio, which
    // would make exports silently vary between a retina and a non-retina screen.
    exportScale: 1,
    // Always export transparent and composite the background ourselves.
    exportBackground: false,
    // The two formats gate dark rendering on different fields: `exportToSvg` reads
    // `exportWithDarkMode`, while the canvas renderer behind PNG checks
    // `theme === 'dark'`. Both are set so the formats agree.
    exportWithDarkMode: resolved.dark,
    theme: resolved.dark ? ('dark' as const) : ('light' as const),
  }

  return { elements, appState, files: scene.files ?? null, background: resolved }
}

/** Produce a standalone SVG for a scene, matching `resolveStandaloneSvg`'s shape
 *  so `ExportMenu` can treat the two kinds uniformly. */
export async function resolveSceneSvg(
  sceneText: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
): Promise<StandaloneSvg> {
  const { exportToSvg } = await import('@excalidraw/excalidraw')
  const { background: resolved, ...input } = sceneExportInput(sceneText, background, config)

  const svg = await exportToSvg({ ...input, exportPadding: 16 })

  const width = parseFloat(svg.getAttribute('width') ?? '') || svg.viewBox?.baseVal?.width || 0
  const height = parseFloat(svg.getAttribute('height') ?? '') || svg.viewBox?.baseVal?.height || 0

  // In dark mode the `filter` sits on the exported <svg> root, so a background
  // rect added inside it would be filtered too. Nesting that whole element inside
  // a plain outer <svg> keeps the filter scoped to the drawing while the rect
  // behind it renders in exactly the requested color.
  const root = resolved.color ? withBackgroundRect(svg, resolved.color, width, height) : svg

  const markup = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(root)}`
  return { markup, width, height }
}

function withBackgroundRect(
  drawing: SVGSVGElement,
  color: string,
  width: number,
  height: number,
): SVGSVGElement {
  const outer = document.createElementNS(SVG_NS, 'svg')
  outer.setAttribute('xmlns', SVG_NS)
  outer.setAttribute('version', '1.1')
  outer.setAttribute('width', String(width))
  outer.setAttribute('height', String(height))
  outer.setAttribute('viewBox', `0 0 ${width} ${height}`)

  const rect = document.createElementNS(SVG_NS, 'rect')
  rect.setAttribute('x', '0')
  rect.setAttribute('y', '0')
  rect.setAttribute('width', String(width))
  rect.setAttribute('height', String(height))
  rect.setAttribute('fill', color)

  drawing.setAttribute('x', '0')
  drawing.setAttribute('y', '0')

  outer.appendChild(rect)
  outer.appendChild(drawing)
  return outer
}

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

export async function exportSceneSVG(
  sceneText: string,
  filename: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
): Promise<void> {
  const { markup } = await resolveSceneSvg(sceneText, background, config)
  triggerDownload(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), filename)
}

export async function copySceneSVG(
  sceneText: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
): Promise<void> {
  const { markup } = await resolveSceneSvg(sceneText, background, config)
  await navigator.clipboard.writeText(markup)
}

/** Rasterize a scene to a PNG blob (shared by download/copy), resolving the
 *  requested density through the same `resolvePngScale` the mermaid path uses so
 *  the two kinds never differ in what "2×" or "300 DPI" means. */
async function renderScenePngBlob(
  sceneText: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
  pngScale?: PngScale,
): Promise<Blob> {
  const { exportToCanvas } = await import('@excalidraw/excalidraw')
  const { background: resolved, ...input } = sceneExportInput(sceneText, background, config)

  const drawing = await exportToCanvas({
    ...input,
    exportPadding: 16,
    // The returned width/height size the canvas *verbatim* — Excalidraw does not multiply them by
    // `scale` (only its `maxWidthOrHeight` branch does that).
    getDimensions: (width: number, height: number) => {
      const scale = resolvePngScale(pngScale, width, height)
      return {
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        scale,
      }
    },
  })

  if (!resolved.color) return canvasToPngBlob(drawing)

  // Same reason as the SVG path: the drawing was rendered transparent (and, in dark
  // mode, filtered), so the chosen color goes underneath it rather than through it.
  const composed = document.createElement('canvas')
  composed.width = drawing.width
  composed.height = drawing.height
  const ctx = composed.getContext('2d')
  if (!ctx) throw new Error('Could not acquire a 2D canvas context.')
  ctx.fillStyle = resolved.color
  ctx.fillRect(0, 0, composed.width, composed.height)
  ctx.drawImage(drawing, 0, 0)
  return canvasToPngBlob(composed)
}

async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Canvas produced no PNG blob.')
  return blob
}

export async function exportScenePNG(
  sceneText: string,
  filename: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
  pngScale?: PngScale,
): Promise<void> {
  triggerDownload(await renderScenePngBlob(sceneText, background, config, pngScale), filename)
}

export async function copyScenePNG(
  sceneText: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
  pngScale?: PngScale,
): Promise<void> {
  const blob = await renderScenePngBlob(sceneText, background, config, pngScale)
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
}

/* ------------------------------------------------------------------ */
/* Thumbnails (Agent Link)                                             */
/* ------------------------------------------------------------------ */

export interface SceneThumbnail {
  mimeType: string
  width: number
  height: number
  /** What the drawing was multiplied by to fit the cap. Never above 1. */
  scale: number
  /** Elements the picture contains, after a crop pulled in whatever the named ones
   *  needed to make sense. */
  rendered: number
  /** The encoded image, base64. The frame carrying it is JSON, so there is nothing
   *  else it could be; the service decodes it back to bytes on the way out. */
  base64: string
}

/** A small picture of a scene, for the agent that drew it. */
export async function renderSceneThumbnail(
  sceneText: string,
  mode: 'light' | 'dark',
  ids?: readonly string[],
): Promise<SceneThumbnail> {
  // Black and white rather than the theme's own surface colour. The agent is being
  // shown this to check a layout, and a literal background is one less thing that
  // can differ between what it sees and what `sceneExportInput` decided the drawing
  // should be themed as — the two are derived from the same value.
  const background: ExportBackground = mode === 'dark' ? 'black' : 'white'

  const first = await encodeThumbnail(sceneText, background, SCENE_RENDER_LONG_EDGE, 0.85, ids)
  if (first.base64.length <= SCENE_RENDER_MAX_BYTES) return first

  // A canvas dense enough to blow the budget at the normal size gets one smaller,
  // rougher attempt. Refusing outright would fail exactly the drawing most likely to
  // have a layout problem worth looking at.
  const second = await encodeThumbnail(
    sceneText,
    background,
    SCENE_RENDER_FALLBACK_LONG_EDGE,
    0.6,
    ids,
  )
  if (second.base64.length <= SCENE_RENDER_MAX_BYTES) return second

  throw new Error(
    'This canvas will not encode small enough to send — it is probably carrying ' +
      'embedded images. Use ideate_scene_get to read the elements instead.',
  )
}

async function encodeThumbnail(
  sceneText: string,
  background: ExportBackground,
  longEdge: number,
  quality: number,
  ids: readonly string[] | undefined,
): Promise<SceneThumbnail> {
  const { exportToCanvas } = await import('@excalidraw/excalidraw')
  const { background: resolved, ...whole } = sceneExportInput(sceneText, background, null)
  const elements = ids ? cropToElements(whole.elements, ids) : whole.elements
  const input = { ...whole, elements }

  // Captured out of the callback, which is the only place the drawing's natural size
  // is available, and reported because it is the answer to "why can I not read this".
  let scale = 1

  const drawing = await exportToCanvas({
    ...input,
    exportPadding: 8,
    getDimensions: (width: number, height: number) => {
      // Never above 1. Upscaling adds pixels and no information — 20px label text is
      // 20px of detail however large it is drawn — and spends the budget doing it.
      // This is the opposite of `rasterScale` on the download path, which pushes a
      // small diagram *up* to a usable print size.
      scale = Math.min(1, longEdge / Math.max(width, height))
      return {
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        scale,
      }
    },
  })

  // Always opaque, unlike every other export here. A transparent PNG handed to a
  // model is composited against whatever its client happens to use, and a drawing
  // in light-mode colours on a dark surface is the one result nobody can read.
  const composed = document.createElement('canvas')
  composed.width = drawing.width
  composed.height = drawing.height
  const ctx = composed.getContext('2d')
  if (!ctx) throw new Error('Could not acquire a 2D canvas context.')
  ctx.fillStyle = resolved.color ?? '#ffffff'
  ctx.fillRect(0, 0, composed.width, composed.height)
  ctx.drawImage(drawing, 0, 0)

  const encoded = await encodeLossy(composed, quality)
  return {
    mimeType: encoded.type,
    width: composed.width,
    height: composed.height,
    scale,
    rendered: elements.length,
    base64: await blobToBase64(encoded),
  }
}

/**
 * Narrow a scene to the elements an agent named, plus whatever they need to read as a drawing
 * rather than as debris.
 */
function cropToElements<T extends { id: string; type: string }>(
  elements: readonly T[],
  ids: readonly string[],
): T[] {
  const byId = new Map(elements.map((element) => [element.id, element]))
  const wanted = new Set<string>()

  for (const id of ids) {
    const element = byId.get(id)
    if (!element) {
      throw new Error(`No element with id "${id}". Call ideate_scene_get to list what is there.`)
    }
    const containerId = (element as { containerId?: string | null }).containerId
    wanted.add(containerId && byId.has(containerId) ? containerId : id)
  }

  const keep = elements.filter((element) => {
    if (wanted.has(element.id)) return true

    const containerId = (element as { containerId?: string | null }).containerId
    if (containerId && wanted.has(containerId)) return true

    if (element.type !== 'arrow' && element.type !== 'line') return false
    const bindings = element as {
      startBinding?: { elementId?: unknown } | null
      endBinding?: { elementId?: unknown } | null
    }
    const start = bindings.startBinding?.elementId
    const end = bindings.endBinding?.elementId
    return (
      typeof start === 'string' && typeof end === 'string' && wanted.has(start) && wanted.has(end)
    )
  })

  if (keep.length === 0) {
    throw new Error('Those ids match nothing that can be drawn.')
  }
  return keep
}

/** WebP where the browser has it, PNG where it does not. Line art is what PNG is
 *  good at, so the fallback costs size rather than fidelity — but at these
 *  dimensions it stays well inside the budget either way. */
async function encodeLossy(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  const webp = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', quality),
  )
  // Safari before 14 answers null; some engines answer a PNG under the requested
  // type, which is why the blob's own `type` is what gets reported rather than the
  // one that was asked for.
  if (webp && webp.type === 'image/webp') return webp
  return canvasToPngBlob(canvas)
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  // Chunked: `String.fromCharCode(...bytes)` on a few hundred kilobytes spreads an
  // argument per byte and overflows the call stack.
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/* ------------------------------------------------------------------ */
/* Scene source                                                        */
/* ------------------------------------------------------------------ */

/**
 * Download the scene JSON itself. Unlike the mermaid source export there's nothing to bake in — a
 * `.excalidraw` file is already self-contained (embedded images included) and opens directly in
 * excalidraw.com.
 */
export async function exportSceneSource(sceneText: string, filename: string): Promise<void> {
  if (!parseScene(sceneText)) throw new Error('This file is not a valid Excalidraw scene.')
  triggerDownload(new Blob([sceneText], { type: 'application/json;charset=utf-8' }), filename)
}

export async function copySceneSource(sceneText: string): Promise<void> {
  if (!parseScene(sceneText)) throw new Error('This file is not a valid Excalidraw scene.')
  await navigator.clipboard.writeText(sceneText)
}
