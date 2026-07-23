import mermaid from 'mermaid'

/**
 * Diagram rendering via the official `mermaid` library.
 *
 * mermaid is browser-only (it measures text against the live DOM), so every
 * entry point here is async and must run client-side. Colors are baked into the
 * SVG at render time from mermaid's built-in `default` theme — there is no
 * CSS-variable theme layer anymore, which is why the exported SVG stands alone
 * with no extra color inlining (see lib/export.ts).
 */

let initialized = false

function ensureInitialized(): void {
  if (initialized) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    // `strict` still renders `<br/>` line breaks in labels; it just forbids raw
    // HTML/scripts. Safe default for arbitrary user diagrams.
    securityLevel: 'strict',
    // Pure-SVG labels (no <foreignObject>/HTML) so exports rasterize cleanly and
    // stand alone; `basis` gives smooth curved edges out of the box.
    flowchart: { htmlLabels: false, curve: 'basis' },
  })
  initialized = true
}

// mermaid.render requires a unique DOM id per call; a monotonic counter keeps
// them distinct across rapid re-renders.
let renderSeq = 0

/**
 * Render `text` to an SVG string, throwing on invalid syntax. On failure mermaid
 * can leave an orphaned temp element behind, so we clean it up before rethrowing.
 */
export async function renderToSvg(text: string): Promise<string> {
  ensureInitialized()
  const id = `mmd-${++renderSeq}`
  try {
    const { svg } = await mermaid.render(id, text)
    return svg
  } catch (err) {
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
    throw err
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
export async function renderPreview(text: string): Promise<RenderResult | RenderError> {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, message: 'Empty diagram.' }
  try {
    const svg = await renderToSvg(text)
    return { ok: true, svg }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
