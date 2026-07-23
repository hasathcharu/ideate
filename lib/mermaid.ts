import mermaid from 'mermaid'
import elkLayouts from '@mermaid-js/layout-elk'

/**
 * Diagram rendering via the official `mermaid` library.
 *
 * mermaid is browser-only (it measures text against the live DOM), so every
 * entry point here is async and must run client-side. Colors are baked into the
 * SVG at render time from mermaid's built-in `default` theme — there is no
 * CSS-variable theme layer anymore, which is why the exported SVG stands alone
 * with no extra color inlining (see lib/export.ts).
 */

/**
 * Selectable layout engine. `dagre` is mermaid's built-in default; `elk` comes
 * from the optional `@mermaid-js/layout-elk` loader (registered below) and often
 * produces tidier layouts for larger flowcharts.
 */
export type LayoutEngine = 'dagre' | 'elk'

export const LAYOUT_ENGINES: ReadonlyArray<{ value: LayoutEngine; label: string }> = [
  { value: 'dagre', label: 'Dagre (default)' },
  { value: 'elk', label: 'ELK' },
]

export const DEFAULT_LAYOUT: LayoutEngine = 'dagre'

// Base config, minus `layout` (which the caller chooses). Re-passed in full on
// every (re)initialize so switching engines can never drop `htmlLabels: false`
// — pure-SVG labels are load-bearing for the standalone export (see lib/export.ts).
const BASE_CONFIG = {
  startOnLoad: false,
  theme: 'default',
  // `strict` still renders `<br/>` line breaks in labels; it just forbids raw
  // HTML/scripts. Safe default for arbitrary user diagrams.
  securityLevel: 'strict',
  // Pure-SVG labels (no <foreignObject>/HTML) so exports rasterize cleanly and
  // stand alone; `basis` gives smooth curved edges out of the box.
  flowchart: { htmlLabels: false, curve: 'basis' },
} as const

let initialized = false
// The layout the global mermaid config is currently set to; re-init only when
// the requested engine actually changes.
let currentLayout: LayoutEngine = DEFAULT_LAYOUT

function ensureInitialized(): void {
  if (initialized) return
  // Register the ELK loader so `layout: 'elk'` resolves; dagre is built in.
  mermaid.registerLayoutLoaders(elkLayouts)
  mermaid.initialize({ ...BASE_CONFIG, layout: currentLayout })
  initialized = true
}

/** Point mermaid's global config at `layout` (a no-op if already set). */
function applyLayout(layout: LayoutEngine): void {
  if (layout === currentLayout) return
  currentLayout = layout
  // Re-pass the full base config: initialize() merges, and passing only { layout }
  // has been observed to let defaults (e.g. htmlLabels) creep back in.
  mermaid.initialize({ ...BASE_CONFIG, layout })
}

/**
 * Guard against a `@mermaid-js/layout-elk` (0.2.x) bug: its renderer eagerly
 * evaluates `JSON.stringify(graph)` as an argument to debug/info/error log calls,
 * and the graph holds d3 selections whose `_parents` array points at <html>. In a
 * React/Next app that element carries React's enumerable `__reactFiber$…`
 * back-reference, so the stringify hits a circular structure and throws — which
 * would otherwise break every ELK render. We can't stop those log-arg evaluations,
 * so while a render is in flight we swap in a JSON.stringify that diverges from
 * native only on the throwing path: non-circular input serializes identically;
 * circular input yields a best-effort string (dropping DOM nodes / repeats) instead
 * of throwing. A depth counter keeps overlapping renders safe; native is restored
 * once none are outstanding.
 */
let stringifyDepth = 0
let nativeStringify: typeof JSON.stringify | null = null

function installCircularSafeStringify(): void {
  if (stringifyDepth++ > 0) return
  const native = JSON.stringify
  nativeStringify = native
  JSON.stringify = function (value, replacer, space) {
    try {
      return native(value as unknown as object, replacer as never, space)
    } catch (err) {
      if (err instanceof TypeError && /circular/i.test(err.message)) {
        const seen = new WeakSet<object>()
        return native(
          value as unknown as object,
          (_key, val) => {
            if (val && typeof val === 'object') {
              if (val instanceof Node) return undefined
              if (seen.has(val)) return undefined
              seen.add(val)
            }
            return val
          },
          space as never,
        )
      }
      throw err
    }
  }
}

function restoreStringify(): void {
  if (--stringifyDepth > 0) return
  if (nativeStringify) {
    JSON.stringify = nativeStringify
    nativeStringify = null
  }
}

// mermaid.render requires a unique DOM id per call; a monotonic counter keeps
// them distinct across rapid re-renders.
let renderSeq = 0

/**
 * Render `text` to an SVG string, throwing on invalid syntax. On failure mermaid
 * can leave an orphaned temp element behind, so we clean it up before rethrowing.
 */
export async function renderToSvg(
  text: string,
  layout: LayoutEngine = DEFAULT_LAYOUT,
): Promise<string> {
  ensureInitialized()
  applyLayout(layout)
  const id = `mmd-${++renderSeq}`
  installCircularSafeStringify()
  try {
    const { svg } = await mermaid.render(id, text)
    return svg
  } catch (err) {
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
    throw err
  } finally {
    restoreStringify()
  }
}

export interface RenderResult {
  ok: true
  svg: string
}
export interface RenderError {
  ok: false
  message: string
}

/** Render the diagram, returning a discriminated result instead of throwing so
 *  the preview can show inline error messages. */
export async function renderPreview(
  text: string,
  layout: LayoutEngine = DEFAULT_LAYOUT,
): Promise<RenderResult | RenderError> {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, message: 'Empty diagram.' }
  try {
    const svg = await renderToSvg(text, layout)
    return { ok: true, svg }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
