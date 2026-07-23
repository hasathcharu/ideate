import mermaid from 'mermaid'
import elkLayouts from '@mermaid-js/layout-elk'
import type { MermaidUserConfig } from './mermaidConfig'

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

let loadersRegistered = false
// A cache key (the serialized user config) of the config mermaid is currently
// initialized with, so we only re-init when something actually changes.
// `null` means "never initialized yet".
let currentKey: string | null = null

/** Deep-merge plain objects (user config over defaults) so overriding e.g.
 *  `flowchart.curve` doesn't wipe out `flowchart.htmlLabels`. Arrays and
 *  scalars from `override` replace the base value outright. */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key]
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = deepMerge(prev, value)
    } else {
      out[key] = value
    }
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Initialize mermaid with the base config merged with the user's config — but
 * only when that config changes. mermaid's `initialize()` rebuilds its site
 * config from the built-in defaults on each call, so passing the full merged
 * object every time keeps removed keys from lingering. The user config is the
 * single source of truth, including `layout` (the dropdown edits the YAML — see
 * `setLayoutInYaml`); we only default it to dagre when the config omits it.
 */
function applyConfig(userConfig: MermaidUserConfig | null): void {
  const key = userConfig ? JSON.stringify(userConfig) : ''
  if (key === currentKey) return
  currentKey = key

  if (!loadersRegistered) {
    // Register the ELK loader so `layout: 'elk'` resolves; dagre is built in.
    mermaid.registerLayoutLoaders(elkLayouts)
    loadersRegistered = true
  }

  const merged = userConfig ? deepMerge(BASE_CONFIG, userConfig) : { ...BASE_CONFIG }
  if (typeof merged.layout !== 'string') merged.layout = DEFAULT_LAYOUT
  mermaid.initialize(merged)
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

/**
 * A themed `fontFamily` (lib/themes.ts) is baked verbatim into the SVG mermaid
 * produces, so the browser must have that face loaded *before* mermaid measures
 * text to size note/label boxes — otherwise the measurement pass silently falls
 * back to a different font than the one that ends up painted, and text overflows
 * its box (this only surfaces with a custom theme; the built-in default theme
 * never requests a custom font, so it never hits the mismatch). Mirrors the same
 * guard already used before PNG rasterization (lib/export.ts).
 */
async function ensureFontsReady(userConfig: MermaidUserConfig | null): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  const family = userConfig?.themeVariables?.fontFamily
  const primary = typeof family === 'string' ? family.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') : undefined
  if (primary) {
    // Kick off the download now rather than waiting for mermaid's own text
    // measurement to lazily trigger it.
    void document.fonts.load(`400 16px "${primary}"`)
  }
  await document.fonts.ready
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
  userConfig: MermaidUserConfig | null = null,
): Promise<string> {
  applyConfig(userConfig)
  await ensureFontsReady(userConfig)
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

/**
 * `@mermaid-js/layout-elk` (0.2.2, latest as of writing) can't lay out
 * state-diagram composite/nested states (`state X { ... }`): it loses the
 * child node's `shape` on the way through ELK's own graph representation, so
 * mermaid's generic cluster renderer throws a bare
 * `shapes[shape] is not a function` — an upstream limitation, not something
 * fixable from the render call here. Recognize that specific failure and
 * point at the fix (switch to Dagre) instead of surfacing the internal error.
 */
function describeRenderError(err: unknown, text: string, userConfig: MermaidUserConfig | null): string {
  const message = err instanceof Error ? err.message : String(err)
  const isElkClusterFailure = /shapes\[.*\] is not a function/.test(message)
  const isElkLayout = userConfig?.layout === 'elk'
  const hasCompositeState = /^\s*state\s+\S+\s*\{/m.test(text)
  if (isElkClusterFailure && isElkLayout && hasCompositeState) {
    return (
      'The ELK layout can’t render composite/nested states (`state X { ... }`) ' +
      'in state diagrams — switch Layout to Dagre for this diagram.'
    )
  }
  return message
}

/** Render the diagram, returning a discriminated result instead of throwing so
 *  the preview can show inline error messages. */
export async function renderPreview(
  text: string,
  userConfig: MermaidUserConfig | null = null,
): Promise<RenderResult | RenderError> {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, message: 'Empty diagram.' }
  try {
    const svg = await renderToSvg(text, userConfig)
    return { ok: true, svg }
  } catch (err) {
    return { ok: false, message: describeRenderError(err, text, userConfig) }
  }
}
