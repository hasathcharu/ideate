import MarkdownIt from 'markdown-it'
import type { Env, MarkdownIt as MarkdownItInstance, Token } from 'markdown-it'
import { renderToSvg } from './mermaid'
import type { MermaidUserConfig } from './mermaidConfig'

/**
 * Markdown documents (`.md` / `.markdown`).
 *
 * A markdown file is prose that may *contain* diagrams: every ```mermaid fence
 * is rendered through the same `renderToSvg` the standalone diagram editor uses,
 * with the same global config — so an embedded diagram picks up the active theme
 * and layout engine without the file itself carrying a single line of theme
 * configuration. The injection happens here at render time and is never written
 * back to the document.
 *
 * Rendering is therefore async and browser-only, exactly like `lib/mermaid.ts`.
 */

/** The fence info-string that marks a code block as a mermaid diagram. */
const MERMAID_FENCE = 'mermaid'

/**
 * `html: false` escapes raw HTML in the source rather than passing it through,
 * which is what keeps this safe without pulling in a separate sanitizer: the
 * only markup that reaches the DOM is markdown-it's own output plus the SVG
 * mermaid produced (itself rendered under `securityLevel: 'strict'`).
 *
 * `linkify` turns bare URLs into links, matching GitHub's rendering. markdown-it
 * validates every link target by default, so `javascript:` URLs never survive.
 */
const md: MarkdownItInstance = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
})

/* ------------------------------------------------------------------ */
/* Task lists                                                          */
/* ------------------------------------------------------------------ */

/**
 * Render `- [ ]` / `- [x]` items as real (disabled) checkboxes.
 *
 * markdown-it is CommonMark, which has no notion of task lists, and this is a
 * ~30-line core rule rather than another dependency. It rewrites the token
 * stream after inline parsing: strip the `[ ]` marker from the item's text,
 * prepend a checkbox, and tag the item and its list so the CSS can drop the
 * bullet and hang the box in the margin.
 */
md.core.ruler.after('inline', 'md-task-lists', (state) => {
  const tokens = state.tokens
  // The most recent open bullet list, so a checkbox item can tag its own list
  // without tagging an enclosing one.
  const listStack: Token[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.type === 'bullet_list_open') listStack.push(token)
    else if (token.type === 'bullet_list_close') listStack.pop()

    if (token.type !== 'inline') continue
    if (tokens[i - 1]?.type !== 'paragraph_open') continue
    const itemOpen = tokens[i - 2]
    if (itemOpen?.type !== 'list_item_open') continue

    const match = /^\[([ xX])\][ \t]+/.exec(token.content)
    if (!match) continue

    const checked = match[1] !== ' '
    const markerLength = match[0].length
    token.content = token.content.slice(markerLength)

    // The inline token's children are what actually render; the first text child
    // holds the same marker and has to be trimmed in step with `content`.
    const firstText = token.children?.[0]
    if (firstText?.type === 'text') {
      firstText.content = firstText.content.slice(markerLength)
    }

    const checkbox = new state.Token('html_inline', '', 0)
    checkbox.content = `<input class="md-task-checkbox" type="checkbox" disabled${
      checked ? ' checked' : ''
    }>`
    token.children?.unshift(checkbox)

    itemOpen.attrJoin('class', 'md-task-item')
    listStack[listStack.length - 1]?.attrJoin('class', 'md-task-list')
  }

  return true
})

/* ------------------------------------------------------------------ */
/* Mermaid fences                                                      */
/* ------------------------------------------------------------------ */

/** One ```mermaid fence found while rendering. `topLevel` decides whether the
 *  diagram can become its own React element (see {@link renderMarkdown}). */
interface FoundFence {
  source: string
  topLevel: boolean
}

/** Per-render state threaded through markdown-it's `env`, so two concurrent
 *  renders can never share a diagram list. */
interface RenderEnv extends Env {
  mermaid?: FoundFence[]
}

/** Placeholder emitted in place of a mermaid fence, swapped for the rendered SVG
 *  once mermaid has run. The index is ours, so the marker is unambiguous. */
function placeholderFor(index: number): string {
  return `<!--md-mermaid:${index}-->`
}

const defaultFence = md.renderer.rules.fence

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const renderFence = () =>
    defaultFence
      ? defaultFence(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)

  const token = tokens[idx]!
  const language = token.info.trim().split(/\s+/)[0]?.toLowerCase()
  if (language !== MERMAID_FENCE) return renderFence()

  // Every call from `renderMarkdown` supplies an env to collect into. Without
  // one there is nothing to resolve the placeholder later, so fall back to
  // rendering the fence as an ordinary code block rather than emitting a
  // placeholder that would survive into the output as a stray comment.
  const store = env as RenderEnv | undefined
  if (!store) return renderFence()

  const list = (store.mermaid ??= [])
  const index = list.length
  // `level === 0` means the fence is a direct child of the document root, so the
  // markup around it can be split at this point without tearing a `<ul>` or
  // `<blockquote>` in half.
  list.push({ source: token.content, topLevel: token.level === 0 })
  return placeholderFor(index)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The markup a fence becomes when its mermaid source doesn't parse. The source
 *  is kept visible so the error points at something actionable. */
function errorBlock(message: string, source: string): string {
  return (
    `<div class="md-mermaid-error">` +
    `<div class="md-mermaid-error-title">Can’t render diagram</div>` +
    `<div>${escapeHtml(message)}</div>` +
    `<pre><code>${escapeHtml(source)}</code></pre>` +
    `</div>`
  )
}

/**
 * One piece of a rendered document: either a run of HTML, or a diagram that gets
 * its own React component.
 */
export type MarkdownPart =
  | { type: 'html'; html: string }
  | { type: 'diagram'; svg: string }

/**
 * Render a markdown document, with every ```mermaid fence turned into a themed
 * diagram.
 *
 * The result is a *list of parts* rather than one HTML string, so that a
 * top-level diagram can be handed to React as a real element (`DiagramViewport`,
 * with its own zoom/pan state) instead of being buried inside a
 * `dangerouslySetInnerHTML` blob React can't attach state or handlers to.
 *
 * Splitting is only safe at `level === 0`. A fence nested in a list item or a
 * blockquote sits between an unclosed `<ul>`/`<blockquote>` and its closing tag,
 * so cutting the string there would hand React two fragments of invalid HTML —
 * those diagrams stay inline as plain SVG, rendered and themed identically, just
 * without the zoom controls. Fences that fail to parse likewise stay inline, as
 * an error block that keeps the offending source visible.
 *
 * Diagrams render **sequentially** rather than through `Promise.all`: mermaid
 * re-`initialize()`s a single global instance per config change and renders
 * against the live DOM, so overlapping renders are a race we gain nothing by
 * taking — a document has a handful of diagrams, not hundreds.
 */
export async function renderMarkdown(
  text: string,
  config: MermaidUserConfig | null = null,
): Promise<MarkdownPart[]> {
  const env: RenderEnv = {}
  let html = md.render(text, env)

  const fences = env.mermaid ?? []
  /** SVG for each fence that stays as its own part, keyed by fence index. */
  const standalone = new Map<number, string>()

  for (let i = 0; i < fences.length; i++) {
    const { source, topLevel } = fences[i]!
    if (!source.trim()) {
      html = html.replace(placeholderFor(i), '')
      continue
    }
    let svg: string
    try {
      svg = await renderToSvg(source, config)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      html = html.replace(placeholderFor(i), () => errorBlock(message, source))
      continue
    }
    if (topLevel) {
      // Leave the placeholder in place; it becomes a split point below.
      standalone.set(i, svg)
    } else {
      html = html.replace(placeholderFor(i), () => `<div class="md-mermaid">${svg}</div>`)
    }
  }

  if (standalone.size === 0) {
    return html ? [{ type: 'html', html }] : []
  }

  // Only top-level placeholders survive to here, so every split lands between
  // two complete blocks. `split` with a capture group yields alternating
  // html / fence-index entries.
  const parts: MarkdownPart[] = []
  const segments = html.split(/<!--md-mermaid:(\d+)-->/)
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    if (i % 2 === 0) {
      if (segment.trim()) parts.push({ type: 'html', html: segment })
    } else {
      const svg = standalone.get(Number(segment))
      if (svg) parts.push({ type: 'diagram', svg })
    }
  }
  return parts
}
