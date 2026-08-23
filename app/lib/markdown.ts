import MarkdownIt from 'markdown-it'
import type { Env, MarkdownIt as MarkdownItInstance, Token } from 'markdown-it'
import footnotePlugin from 'markdown-it-footnote'
import { full as emojiPlugin } from 'markdown-it-emoji'
import DOMPurify from 'dompurify'
import { renderToSvg } from './mermaid'
import { resolveThemeMode, type MermaidUserConfig } from './mermaidConfig'
import { highlightCode } from './highlight'

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
 * Everything else here exists to render a document the way **GitHub** renders
 * it, since that is where these files live:
 *
 * - **Raw HTML passes through**, sanitized (see {@link sanitizeHtml}). `<details>`
 *   /`<summary>`, `<kbd>`, `<sub>`/`<sup>`, alignment wrappers and inline tables
 *   are all common in real repo documents, and escaping them showed the markup
 *   instead of the content.
 * - **GFM extras**: tables, strikethrough, autolinked URLs, task lists,
 *   footnotes, `:emoji:` shortcodes, and `> [!NOTE]`-style alerts.
 * - **Code fences are syntax highlighted** (`lib/highlight.ts`, lazily loaded).
 * - **Headings get slug ids** matching GitHub's, so `#some-heading` links work —
 *   and so the reading view can offer an outline.
 * - **Relative links and images resolve against the repository**: a link to
 *   another file in the repo opens in the editor (`data-md-repo-link`), and a
 *   relative image is rewritten to its raw.githubusercontent URL.
 *
 * Rendering is therefore async and browser-only, exactly like `lib/mermaid.ts`.
 */

/** The fence info-string that marks a code block as a mermaid diagram. */
const MERMAID_FENCE = 'mermaid'

/** Where the document being rendered lives, so relative links and images can be
 *  resolved the way GitHub resolves them. */
export interface MarkdownRepoLocator {
  owner: string
  name: string
  branch: string
}

export interface MarkdownRenderOptions {
  /** Global mermaid config — themes the embedded diagrams and picks the light or
   *  dark syntax-highlighting palette. */
  config?: MermaidUserConfig | null
  /** Repo-relative path of the document itself. Relative links resolve against
   *  its directory; without it they are left alone. */
  basePath?: string | null
  /** The repository the document lives in, for blob/raw URLs. */
  repo?: MarkdownRepoLocator | null
}

/**
 * `html: true` lets raw HTML through, so the output has to be sanitized before it
 * reaches the DOM — see {@link sanitizeHtml}, which every render passes through.
 *
 * `linkify` turns bare URLs into links, matching GitHub's rendering. markdown-it
 * validates every link target by default, so `javascript:` URLs never survive.
 */
const md: MarkdownItInstance = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
})

md.use(footnotePlugin)
md.use(emojiPlugin)

/* ------------------------------------------------------------------ */
/* Per-render state                                                    */
/* ------------------------------------------------------------------ */

/** One ```mermaid fence found while rendering. `topLevel` decides whether the
 *  diagram can become its own React element (see {@link renderMarkdown}). */
interface FoundFence {
  source: string
  topLevel: boolean
  /** 1-based line the fence opens on, for the scroll sync (see
   *  {@link SOURCE_LINE_ATTR}). */
  line: number | null
}

/** One ordinary code fence, held back so shiki can highlight it asynchronously. */
interface FoundCode {
  source: string
  language: string
  /** Markup to fall back to if highlighting isn't possible. */
  fallback: string
  /** 1-based line the fence opens on. */
  line: number | null
}

/** A heading in the rendered document, in document order. */
export interface MarkdownHeading {
  /** Slug id set on the heading element — the scroll target. */
  id: string
  /** 1–6. */
  level: number
  /** Plain text of the heading. */
  text: string
}

/** Per-render state threaded through markdown-it's `env`, so two concurrent
 *  renders can never share a diagram list, an outline, or a slug counter. */
interface RenderEnv extends Env {
  mermaid?: FoundFence[]
  code?: FoundCode[]
  headings?: MarkdownHeading[]
  slugs?: Map<string, number>
  basePath?: string | null
  repo?: MarkdownRepoLocator | null
}

/** Placeholders emitted in place of a fence, swapped for the rendered SVG or the
 *  highlighted code once the async work is done.
 *
 *  They are elements rather than HTML comments because the sanitizer strips
 *  comments — and substitution has to happen *after* sanitizing, so that our own
 *  trusted SVG and shiki markup never pass through it. A document that authors
 *  one of these attributes by hand in raw HTML could therefore duplicate one of
 *  its own diagrams; harmless (the content is still ours) and not worth
 *  defending against. */
function mermaidPlaceholder(index: number): string {
  return `<span data-md-mermaid="${index}"></span>`
}
function codePlaceholder(index: number): string {
  return `<span data-md-code="${index}"></span>`
}

/** Matches a placeholder however the sanitizer chose to re-serialize it. */
function placeholderPattern(attribute: string, flags: string): RegExp {
  return new RegExp(`<span[^>]*\\s${attribute}="(\\d+)"[^>]*><\\/span>`, flags)
}

/* ------------------------------------------------------------------ */
/* Sanitizing                                                          */
/* ------------------------------------------------------------------ */

/**
 * Strip anything executable out of the rendered HTML.
 *
 * With `html: true` the document's own markup reaches the output, so this is the
 * boundary that keeps a `.md` file from running script in the app. DOMPurify's
 * defaults already drop `<script>`, `<iframe>`, `on*` handlers and
 * `javascript:` URLs; the additions here are the two GitHub also refuses —
 * `<style>` (a document must not restyle the app around it) and `<form>` (there
 * is nothing legitimate for it to submit to).
 *
 * `<input>` is deliberately *not* forbidden: the task-list rule below renders
 * checkboxes with it, and a disabled checkbox is inert.
 */
function sanitizeHtml(html: string): string {
  // Sanitizing needs a DOM. renderMarkdown is browser-only by contract (mermaid
  // measures against the live DOM), so reaching this without one is a bug in the
  // caller — fail closed rather than hand unsanitized markup to whatever asked.
  if (!DOMPurify.isSupported) return ''
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form'],
    // markdown-it emits `target` on nothing by itself, but the link rule below
    // adds it to external links.
    ADD_ATTR: ['target'],
  })
}

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
/* Alerts (> [!NOTE] …)                                                */
/* ------------------------------------------------------------------ */

/** The five alert kinds GitHub recognizes, with the icon each one shows. Bare
 *  stroked glyphs in `currentColor`, matching `components/icons.tsx`. */
const ALERT_ICONS: Record<string, string> = {
  note: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>',
  tip: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"/>',
  important:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/><path d="M12 7v5M12 15h.01"/>',
  warning: '<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
  caution:
    '<path d="M8.6 3h6.8L21 8.6v6.8L15.4 21H8.6L3 15.4V8.6L8.6 3Z"/><path d="M12 8v4M12 16h.01"/>',
}

const ALERT_LABELS: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
}

function alertTitle(kind: string): string {
  return (
    `<span class="md-alert-icon" aria-hidden="true">` +
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ` +
    `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ALERT_ICONS[kind]}</svg>` +
    `</span>${ALERT_LABELS[kind]}`
  )
}

/**
 * Turn a blockquote whose first line is `[!NOTE]` (or TIP / IMPORTANT / WARNING /
 * CAUTION) into a titled callout, the way GitHub does.
 *
 * The marker paragraph is rewritten in place: the `[!KIND]` text is cut from the
 * first paragraph, a title paragraph is spliced in ahead of it, and the leading
 * newline that separated the marker from the body is dropped. A marker sitting
 * alone on its line leaves an empty paragraph behind, which is removed rather
 * than rendered as a gap.
 */
md.core.ruler.after('inline', 'md-alerts', (state) => {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.type !== 'blockquote_open') continue
    if (tokens[i + 1]?.type !== 'paragraph_open') continue
    const inline = tokens[i + 2]
    if (inline?.type !== 'inline') continue

    const match = /^\[!(note|tip|important|warning|caution)\][ \t]*/i.exec(inline.content)
    if (!match) continue
    const kind = match[1]!.toLowerCase()

    inline.content = inline.content.slice(match[0].length)
    const children = inline.children ?? []
    const firstText = children[0]
    if (firstText?.type === 'text') {
      firstText.content = firstText.content.slice(match[0].length)
      if (!firstText.content) children.shift()
    }
    // The break between the marker line and the body belongs to the title, which
    // is now its own paragraph.
    if (children[0]?.type === 'softbreak') children.shift()
    inline.children = children

    tokens[i]!.attrJoin('class', `md-alert md-alert-${kind}`)

    const titleOpen = new state.Token('paragraph_open', 'p', 1)
    titleOpen.attrSet('class', 'md-alert-title')
    const titleInline = new state.Token('inline', '', 0)
    titleInline.content = ''
    const titleHtml = new state.Token('html_inline', '', 0)
    titleHtml.content = alertTitle(kind)
    titleInline.children = [titleHtml]
    const titleClose = new state.Token('paragraph_close', 'p', -1)

    // An alert whose marker was alone on its line leaves the original paragraph
    // empty; drop it so the callout doesn't open with a blank line.
    const bodyEmpty = children.length === 0
    const removeCount = bodyEmpty ? 3 : 0
    tokens.splice(i + 1, removeCount, titleOpen, titleInline, titleClose)
  }
  return true
})

/* ------------------------------------------------------------------ */
/* Heading slugs + outline                                             */
/* ------------------------------------------------------------------ */

/**
 * GitHub's heading slug: lowercase, punctuation dropped, spaces to hyphens.
 * Letters and numbers are matched by Unicode property so non-Latin headings keep
 * a usable id instead of collapsing to an empty string.
 */
function slugify(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]+/gu, '')
    .replace(/\s+/g, '-')
  return base || 'section'
}

/** Plain text of a heading, for the slug and the outline entry. */
function headingText(inline: Token): string {
  const children = inline.children
  if (!children) return inline.content
  // `emoji` is included so a heading written with a `:shortcode:` reads as the
  // emoji in the outline, rather than as the shortcode text.
  return children
    .filter(
      (child) =>
        child.type === 'text' || child.type === 'code_inline' || child.type === 'emoji',
    )
    .map((child) => child.content)
    .join('')
    .trim()
}

/**
 * Give every heading a unique slug id and collect the document outline.
 *
 * Both come out of the same pass because they need the same de-duplicated slug:
 * the id is the anchor a `#link` (or the reading view's outline) jumps to, and
 * the outline entry has to name that exact id.
 */
md.core.ruler.after('inline', 'md-headings', (state) => {
  const env = state.env as RenderEnv
  const headings = (env.headings ??= [])
  const seen = (env.slugs ??= new Map<string, number>())
  const tokens = state.tokens

  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i]!
    if (open.type !== 'heading_open') continue
    const inline = tokens[i + 1]
    if (inline?.type !== 'inline') continue

    const text = headingText(inline)
    const base = slugify(text)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const id = count === 0 ? base : `${base}-${count}`

    open.attrSet('id', id)
    open.attrJoin('class', 'md-heading')
    headings.push({ id, level: Number(open.tag.slice(1)) || 1, text })

    // A hover-revealed permalink, like GitHub's — appended so it doesn't shift
    // the heading text.
    const anchor = new state.Token('html_inline', '', 0)
    anchor.content =
      `<a class="md-heading-anchor" href="#${id}" aria-label="Permalink to “${escapeHtml(text)}”">` +
      `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ` +
      `stroke-width="1.8" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/>` +
      `<path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg></a>`
    inline.children = [...(inline.children ?? []), anchor]
  }
  return true
})

/* ------------------------------------------------------------------ */
/* Source lines (editor ↔ preview scroll sync)                         */
/* ------------------------------------------------------------------ */

/**
 * Attribute carrying the 1-based source line a rendered block came from.
 *
 * This is the whole basis of the two-way scroll sync in `MarkdownPreview`:
 * double-clicking a line in the editor scrolls to the deepest block that starts
 * at or before it, and double-clicking a block in the document puts the cursor on
 * the line it was written on. markdown-it already knows the answer — every block
 * token carries a `map` — so this is a matter of publishing it into the DOM rather
 * than re-deriving a mapping by counting rendered elements, which no amount of
 * care makes correct across raw HTML, footnotes and nested lists.
 */
export const SOURCE_LINE_ATTR = 'data-md-line'

/** The line a block token starts on, 1-based to match the editor, or null when
 *  markdown-it didn't map it (tokens the plugins above splice in by hand). */
function sourceLine(token: Token): number | null {
  const start = token.map?.[0]
  return typeof start === 'number' ? start + 1 : null
}

/**
 * Stamp every rendered block with the line it came from.
 *
 * The block token stream is flat — only *inline* children nest — so one pass
 * reaches a paragraph inside a list item inside a blockquote as readily as a
 * top-level heading, and the sync gets that granularity for free.
 *
 * Skipped: closing tokens (no element of their own), `inline` tokens (they render
 * their children, not a tag, so an attribute on one goes nowhere), and the
 * synthetic tokens the alert/task-list rules splice in, which have no map. Fences
 * are stamped too, but not from here: they render as placeholders, so they carry
 * their line through {@link FoundFence} / {@link FoundCode} instead.
 */
md.core.ruler.push('md-source-lines', (state) => {
  for (const token of state.tokens) {
    if (token.nesting < 0 || token.type === 'inline') continue
    const line = sourceLine(token)
    if (line !== null) token.attrSet(SOURCE_LINE_ATTR, String(line))
  }
  return true
})

/* ------------------------------------------------------------------ */
/* Links and images                                                    */
/* ------------------------------------------------------------------ */

/** An attribute as a string. markdown-it types attribute values as
 *  `string | number`, and every URL-ish attribute here is read as text. */
function attrText(token: Token, name: string): string | null {
  const value = token.attrGet(name)
  return value === null ? null : String(value)
}

/** True for an href that leaves the repository: an absolute URL, a
 *  protocol-relative one, or any scheme (`mailto:`, `tel:`…). */
function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.\-]*:/i.test(href) || href.startsWith('//')
}

/**
 * Resolve a document-relative href to a repo-relative path, or null when it
 * isn't one (an absolute URL, a bare `#anchor`, or a path that climbs out of the
 * repository root).
 *
 * A leading `/` is repo-root-relative, matching how GitHub reads it inside a
 * repository document.
 */
export function resolveRepoPath(
  basePath: string | null | undefined,
  href: string,
): string | null {
  const target = href.split('#')[0]!.split('?')[0]!
  if (!target || isExternalHref(target)) return null

  let raw: string
  try {
    raw = decodeURIComponent(target)
  } catch {
    raw = target
  }

  const fromRoot = raw.startsWith('/')
  const baseDir = fromRoot ? [] : (basePath ?? '').split('/').slice(0, -1).filter(Boolean)
  const segments = [...baseDir]
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      // Climbing above the repository root has no meaning here.
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return segments.length > 0 ? segments.join('/') : null
}

function blobUrl(repo: MarkdownRepoLocator, path: string): string {
  return `https://github.com/${repo.owner}/${repo.name}/blob/${encodeURIComponent(
    repo.branch,
  )}/${path.split('/').map(encodeURIComponent).join('/')}`
}

function rawUrl(repo: MarkdownRepoLocator, path: string): string {
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${encodeURIComponent(
    repo.branch,
  )}/${path.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Wire the document into its repository.
 *
 * Three kinds of link get three treatments, mirroring what GitHub does with the
 * same markup:
 *
 * - **External** — opened in a new tab, with `rel` hardened.
 * - **In-page** (`#heading`) — left alone; the reading view scrolls to the slug.
 * - **Repo-relative** — tagged with the resolved repo path in
 *   `data-md-repo-link`, which `MarkdownPreview` intercepts to open the file in
 *   the editor. `href` still points at the file's GitHub page, so ⌘-click and
 *   "open in new tab" land somewhere real instead of a 404 under `/editor`.
 *
 * Relative image sources are rewritten to raw.githubusercontent.com, since a
 * repo-relative `src` resolves against the app's own origin otherwise and never
 * loads.
 */
md.core.ruler.after('inline', 'md-repo-links', (state) => {
  const env = state.env as RenderEnv
  const basePath = env.basePath ?? null
  const repo = env.repo ?? null

  for (const token of state.tokens) {
    if (token.type !== 'inline') continue
    for (const child of token.children ?? []) {
      if (child.type === 'image') {
        const src = attrText(child, 'src')
        if (!src || isExternalHref(src) || src.startsWith('#') || !repo) continue
        const path = resolveRepoPath(basePath, src)
        if (path) child.attrSet('src', rawUrl(repo, path))
        continue
      }
      if (child.type !== 'link_open') continue
      const href = attrText(child, 'href')
      if (!href) continue
      if (href.startsWith('#')) continue
      if (isExternalHref(href)) {
        child.attrSet('target', '_blank')
        child.attrSet('rel', 'noopener noreferrer')
        continue
      }
      const path = resolveRepoPath(basePath, href)
      if (!path) continue
      child.attrSet('data-md-repo-link', path)
      const hash = href.includes('#') ? `#${href.split('#').slice(1).join('#')}` : ''
      if (hash) child.attrSet('data-md-repo-hash', hash.slice(1))
      if (repo) child.attrSet('href', blobUrl(repo, path))
    }
  }
  return true
})

/* ------------------------------------------------------------------ */
/* Fences                                                             */
/* ------------------------------------------------------------------ */

const defaultFence = md.renderer.rules.fence

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const renderFence = () =>
    defaultFence
      ? defaultFence(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)

  const token = tokens[idx]!
  const language = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''

  // Every call from `renderMarkdown` supplies an env to collect into. Without
  // one there is nothing to resolve a placeholder later, so fall back to
  // rendering the fence as an ordinary code block rather than emitting a
  // placeholder that would survive into the output as a stray element.
  const store = env as RenderEnv | undefined
  if (!store) return renderFence()

  if (language === MERMAID_FENCE) {
    const list = (store.mermaid ??= [])
    const index = list.length
    // `level === 0` means the fence is a direct child of the document root, so
    // the markup around it can be split at this point without tearing a `<ul>`
    // or `<blockquote>` in half.
    list.push({
      source: token.content,
      topLevel: token.level === 0,
      line: sourceLine(token),
    })
    return mermaidPlaceholder(index)
  }

  if (!language) return renderFence()

  // An ordinary fence with a language: hold it back for shiki, keeping the plain
  // rendering as the fallback for an unknown language or a failed load.
  const list = (store.code ??= [])
  const index = list.length
  list.push({
    source: token.content,
    language,
    fallback: renderFence(),
    line: sourceLine(token),
  })
  return codePlaceholder(index)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Add the source-line attribute to markup whose outermost tag we didn't author.
 *
 * A fence renders as a placeholder, so the core rule above can't reach it — its
 * line has to be grafted onto whatever comes back from shiki (or from
 * markdown-it's fallback), both of which open with a `<pre …>`. Anything that
 * doesn't start with a tag is returned untouched rather than guessed at.
 */
function withSourceLine(markup: string, line: number | null): string {
  if (line === null) return markup
  return markup.replace(/^(\s*<[a-zA-Z][^\s/>]*)/, `$1 ${SOURCE_LINE_ATTR}="${line}"`)
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
  | { type: 'diagram'; svg: string; line: number | null }

/** A rendered document: its content, plus the outline the reading view offers. */
export interface MarkdownRender {
  parts: MarkdownPart[]
  headings: MarkdownHeading[]
}

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
 * The order of the passes below matters. markdown-it renders *placeholders* for
 * both mermaid fences and highlighted code; the HTML is sanitized while those
 * placeholders are still in it; only then is our own trusted markup substituted
 * in. That way the sanitizer never sees — and so can never mangle — mermaid's
 * SVG or shiki's token spans, and the document's own raw HTML never escapes it.
 *
 * Diagrams render **sequentially** rather than through `Promise.all`: mermaid
 * re-`initialize()`s a single global instance per config change and renders
 * against the live DOM, so overlapping renders are a race we gain nothing by
 * taking — a document has a handful of diagrams, not hundreds. Highlighting has
 * no such constraint and runs in parallel.
 */
export async function renderMarkdown(
  text: string,
  options: MarkdownRenderOptions = {},
): Promise<MarkdownRender> {
  const { config = null, basePath = null, repo = null } = options
  const env: RenderEnv = { basePath, repo }
  let html = sanitizeHtml(md.render(text, env))
  const headings = env.headings ?? []

  /* Code fences: highlight in parallel, then substitute. */
  const codeFences = env.code ?? []
  if (codeFences.length > 0) {
    const mode = resolveThemeMode(config)
    const highlighted = await Promise.all(
      codeFences.map((fence) => highlightCode(fence.source, fence.language, mode)),
    )
    html = html.replace(placeholderPattern('data-md-code', 'g'), (match, index: string) => {
      const fence = codeFences[Number(index)]
      if (!fence) return match
      return withSourceLine(highlighted[Number(index)] ?? fence.fallback, fence.line)
    })
  }

  /* Mermaid fences: render sequentially, into inline markup or a split point. */
  const fences = env.mermaid ?? []
  /** SVG for each fence that becomes its own part, keyed by fence index. */
  const standalone = new Map<number, string>()
  /** Markup for each fence that stays inline (nested, empty, or unparseable). */
  const inline = new Map<number, string>()

  for (let i = 0; i < fences.length; i++) {
    const { source, topLevel, line } = fences[i]!
    if (!source.trim()) {
      inline.set(i, '')
      continue
    }
    let svg: string
    try {
      svg = await renderToSvg(source, config)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      inline.set(i, withSourceLine(errorBlock(message, source), line))
      continue
    }
    if (topLevel) standalone.set(i, svg)
    else {
      const attr = line === null ? '' : ` ${SOURCE_LINE_ATTR}="${line}"`
      inline.set(i, `<div class="md-mermaid"${attr}>${svg}</div>`)
    }
  }

  // One pass over the placeholders: inline diagrams are substituted outright,
  // while a standalone one becomes a split marker. The marker can be a comment
  // because nothing sanitizes the HTML after this point.
  html = html.replace(placeholderPattern('data-md-mermaid', 'g'), (_match, index: string) => {
    const i = Number(index)
    if (standalone.has(i)) return `<!--md-mermaid:${i}-->`
    return inline.get(i) ?? ''
  })

  if (standalone.size === 0) {
    return { parts: html ? [{ type: 'html', html }] : [], headings }
  }

  // Only top-level fences produced a marker, so every split lands between two
  // complete blocks. `split` with a capture group yields alternating
  // html / fence-index entries.
  const parts: MarkdownPart[] = []
  const segments = html.split(/<!--md-mermaid:(\d+)-->/)
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    if (i % 2 === 0) {
      if (segment.trim()) parts.push({ type: 'html', html: segment })
    } else {
      const index = Number(segment)
      const svg = standalone.get(index)
      // A standalone diagram becomes its own React element, so its line travels
      // as a field rather than as an attribute in a string.
      if (svg) parts.push({ type: 'diagram', svg, line: fences[index]?.line ?? null })
    }
  }
  return { parts, headings }
}
