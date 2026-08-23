import { parseScene } from './excalidraw'
import { isDarkColor, resolveThemeMode, themeBackgroundColor } from './mermaidConfig'
import type { MermaidUserConfig } from './mermaidConfig'
import { rasterScale } from './export'
import type { StandaloneSvg } from './export'
import type { ExportBackground } from './types'

/**
 * Export pipeline for Excalidraw scenes — the counterpart to `lib/export.ts`,
 * which handles mermaid.
 *
 * Excalidraw ships its own exporters, and they already do what `lib/export.ts`
 * has to do by hand for mermaid: `exportToSvg` inlines the fonts it used and
 * emits explicit pixel dimensions, so the markup stands alone with no extra
 * normalization. That's why this is a separate module rather than another branch
 * inside `resolveStandaloneSvg`.
 *
 * Every entry point loads the library through a *dynamic* `import()`. A static
 * import here would pull the ~1MB editor into the main bundle by way of
 * `ExportMenu`, which `AppShell` imports eagerly — the same reason `Canvas.tsx`
 * exists as a wrapper.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

interface ResolvedBackground {
  /** The exact color to composite behind the drawing, or null for transparent. */
  color: string | null
  /** Whether to render the drawing in Excalidraw's dark theme. */
  dark: boolean
}

/**
 * Resolve the chosen background into a literal color plus the theme the drawing
 * should be rendered in.
 *
 * The theme follows the *background*, which is the whole point: Excalidraw stores
 * light-mode colors (dark strokes), so painting them onto a dark surface without
 * switching theme produces a drawing that's technically present and practically
 * invisible. Deriving the theme from the surface's luminance means "Black" yields
 * light strokes on black, "White" yields dark strokes on white, and "Theme"
 * follows whichever palette is active.
 *
 * Transparent is the one case with no surface to judge, so it follows the active
 * theme's own light/dark mode instead. Reading the scene's stored canvas color
 * there would be misleading: that value is always the file's own (effectively
 * always white, since the displayed background is theme-driven chrome the file
 * never records), so a transparent export always came out light-themed no matter
 * which palette was active. The active mode is the honest signal — it's what the
 * user is looking at, and someone exporting transparent from a dark canvas is
 * almost certainly placing the result on a dark surface.
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
    //
    // Excalidraw's dark theme is a *filter* — `invert(93%) hue-rotate(180deg)` —
    // and it paints the background inside that filter. So asking Excalidraw for a
    // dark-themed image with a background color returns the hue-rotated inverse of
    // the color requested, which is how picking "White" under a dark theme used to
    // produce a black image with swapped colors. Exporting transparent keeps the
    // filter on the drawing only, and lets the requested color land exactly.
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

/** Rasterize a scene to a high-DPI PNG blob (shared by download/copy), using the
 *  same size-aware scale as the mermaid path so the two formats don't differ in
 *  output density. */
async function renderScenePngBlob(
  sceneText: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
): Promise<Blob> {
  const { exportToCanvas } = await import('@excalidraw/excalidraw')
  const { background: resolved, ...input } = sceneExportInput(sceneText, background, config)

  const drawing = await exportToCanvas({
    ...input,
    exportPadding: 16,
    // The returned width/height size the canvas *verbatim* — Excalidraw does not
    // multiply them by `scale` (only its `maxWidthOrHeight` branch does that).
    // `scale` is applied to the drawing, so returning the natural size alongside a
    // 3× scale rendered the scene 3× larger than the bitmap and cropped it to the
    // top-left corner. Both have to be scaled together.
    //
    // The scale is computed here rather than outside because it depends on the
    // scene's natural dimensions, which only this callback receives.
    getDimensions: (width: number, height: number) => {
      const scale = rasterScale(width, height)
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
): Promise<void> {
  triggerDownload(await renderScenePngBlob(sceneText, background, config), filename)
}

export async function copyScenePNG(
  sceneText: string,
  background: ExportBackground,
  config?: MermaidUserConfig | null,
): Promise<void> {
  const blob = await renderScenePngBlob(sceneText, background, config)
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
}

/* ------------------------------------------------------------------ */
/* Scene source                                                        */
/* ------------------------------------------------------------------ */

/**
 * Download the scene JSON itself. Unlike the mermaid source export there's
 * nothing to bake in — a `.excalidraw` file is already self-contained (embedded
 * images included) and opens directly in excalidraw.com.
 */
export async function exportSceneSource(sceneText: string, filename: string): Promise<void> {
  if (!parseScene(sceneText)) throw new Error('This file is not a valid Excalidraw scene.')
  triggerDownload(new Blob([sceneText], { type: 'application/json;charset=utf-8' }), filename)
}

export async function copySceneSource(sceneText: string): Promise<void> {
  if (!parseScene(sceneText)) throw new Error('This file is not a valid Excalidraw scene.')
  await navigator.clipboard.writeText(sceneText)
}
