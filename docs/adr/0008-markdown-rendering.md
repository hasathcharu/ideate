# 0008. Rendering a document the way GitHub does

**Status** accepted &nbsp;·&nbsp; **Touches** `app/lib/markdown.ts, app/lib/highlight.ts, app/components/MarkdownPreview.tsx, app/components/DiagramViewport.tsx`

The invariants this record justifies are listed in [`CLAUDE.md`](../../CLAUDE.md). This file holds the reasoning behind them — read it before changing any of them, and update it here when a decision actually changes.

---

## Markdown documents borrow the same config

A ```mermaid fence inside a `.md` renders through the very same `renderToSvg` and
the very same global config, so an embedded diagram is themed identically to a
standalone one — the Theme *and* Layout dropdowns and the config cogwheel all stay
visible for markdown for exactly that reason (`kind !== 'excalidraw'` in
`AppShell.tsx`). **The config is injected at render time and never written into
the document**: the file in the repo holds bare ```mermaid fences, which is what
lets GitHub render it too. Only the "Markdown + Theme" export bakes it in, into a
copy.

Embedded diagrams get the same zoom/pan/fit controls as the diagram pane, because
they are literally the same component. To make that possible `renderMarkdown`
returns a **list of parts** (`MarkdownPart[]`) rather than one HTML string:
`MarkdownPreview` renders each prose run as a `dangerouslySetInnerHTML` div and
each diagram as a real `DiagramViewport` sibling, so React owns every diagram
outright.

**Do not go back to portaling a viewport into a node that innerHTML created.**
That was tried and it fails: React replaces the whole subtree when the HTML
changes, so the portal keeps rendering into a node it has already detached — the
SVG lands in an orphan and the document shows an empty box. The bug is invisible
to typecheck and only reproduces on re-render.

Splitting is only legal at `token.level === 0`. A fence nested in a list item or
blockquote sits between an unclosed `<ul>`/`<blockquote>` and its closing tag, so
cutting there would produce two fragments of invalid HTML — those stay **inline**
as plain SVG (rendered and themed identically, just without zoom controls), as do
fences that fail to parse. Hence the prose runs are wrapped in `.md-prose-run`,
which is `display: contents` so its children still lay out and match the
`.md-prose > *` selectors as if they were direct children.

**A maximized viewport must be opaque.** "Fill window" turns the box into a
`fixed inset-0` overlay, so whatever `background` resolves to becomes the whole
screen — and an *omitted* background (the natural value for an inline figure that
should show the document through it) left the editor and prose visible around the
diagram. `DiagramViewport` therefore substitutes an opaque fallback whenever it is
maximized with no background (or `'transparent'`), and `Preview`/`MarkdownPreview`
each resolve one surface color that they use for their own pane *and* hand to the
diagrams on it, so the two can't disagree. The fallback is white, not
`var(--background)`: an untuned diagram uses mermaid's dark-on-light default
palette and would be unreadable on a dark surface.

`DiagramViewport`'s one behavioral fork is the wheel: full-pane zooms on a bare
wheel, embedded requires Ctrl/⌘ (the platform zoom modifier, and what a trackpad
pinch reports). An embedded diagram sits inside a scrolling document, so trapping
a bare wheel would turn every diagram into a scroll dead-zone. Maximized, an
embedded figure owns the screen and reverts to bare-wheel zoom.

The prose itself is styled by `.md-prose` in `app/globals.css`, written against
the shadcn tokens rather than literal colors, so a rendered document follows
`applyThemeToSite` like the rest of the chrome. Diagrams render **sequentially**,
not through `Promise.all`: mermaid re-`initialize()`s one global instance and
measures against the live DOM, so overlapping renders are a race with nothing to
gain. Code fences have no such constraint and are highlighted in parallel.

### Rendering a document the way GitHub does

markdown-it runs with **`html: true`**, plus footnotes, `:emoji:` shortcodes,
task lists, `> [!NOTE]`-style alerts, GitHub-compatible heading slugs, and shiki
syntax highlighting. Raw HTML matters because real repo documents are full of it
(`<details>`, `<kbd>`, alignment wrappers), and escaping it showed the markup
instead of the content.

That makes **sanitizing the boundary that keeps a `.md` file from running script
in the app**, and it fixes the order of the passes in `renderMarkdown`:

1. markdown-it renders, emitting a `<span data-md-mermaid|data-md-code="N">`
   **placeholder** for every mermaid fence and every highlighted code fence.
2. The whole string goes through DOMPurify (`sanitizeHtml`) — `<style>` and
   `<form>` on top of its defaults, `<input>` deliberately allowed for task-list
   checkboxes.
3. *Then* the placeholders are swapped for our own trusted markup.

So the sanitizer never sees mermaid's SVG or shiki's token spans (it would mangle
them), and the document's own HTML never escapes it. Placeholders are elements
rather than HTML comments precisely because the sanitizer strips comments — but
once substitution starts, nothing sanitizes any more, which is why the top-level
mermaid split marker *is* a comment. `sanitizeHtml` returns `''` when there is no
DOM: rendering is browser-only by contract, so that is a caller bug, and failing
closed is the only safe answer.

Two traps in shiki's output, both of which show up as an oddly airy code block:
it separates its `<span class="line">`s with **real newline characters** (so the
block still copies as text), which in a `white-space: pre` context *are* the line
breaks — giving those spans `display: block` on top of them breaks every line twice
and double-spaces the whole block. And the fence content markdown-it hands over
still carries its closing newline, which shiki faithfully renders as one more empty
line; `highlightCode` trims it. Code blocks also set their own `line-height`, since
`.md-prose`'s 1.7 is leading for sentences and leaves code looking double-spaced.

**shiki is lazily imported** (`lib/highlight.ts`) and only when a fence carries a
language — a prose-only document, and every mermaid-only user, pays nothing. It
runs on the JS regex engine rather than Oniguruma (no WASM payload), loads both
GitHub themes up front and picks one from `resolveThemeMode`, and its own `pre`
background is stripped so the block keeps the themed `.md-prose pre` surface.
Highlighting failures return `null` and fall back to the plain fence.

### The document is wired into the repository

`renderMarkdown` takes the document's own path and the repo, and resolves
relative links and images the way GitHub does:

- A **repo-relative link** is tagged `data-md-repo-link="<resolved path>"`, and
  its `href` is rewritten to the file's GitHub blob URL. `MarkdownPreview`
  intercepts a plain click and opens the file in the editor; ⌘/Ctrl-click still
  follows the href to GitHub. The href rewrite is not cosmetic — left as a
  relative path, an "open in new tab" would navigate to a 404 *under `/editor`*,
  which is why a click is `preventDefault`ed outright when no repo is connected.
- **Following a link is undoable.** `AppShell` keeps a `linkTrail` of the files a
  link was followed *from*, and shows a Back button while it is non-empty. Only
  link navigation pushes onto it — opening a file from the tree clears it, because
  a Back button that then jumped to an unrelated file is worse than none.
- **Resting on such a link previews the file** (`components/FileHoverCard.tsx`):
  fetched through `readFile`, cached per repo+branch+path, rendered from a
  truncated copy of the source, and `pointer-events: none` so the card never has
  to negotiate hover with the link that opened it. A scene shows its element
  count — drawing a real thumbnail would mean pulling in the Excalidraw bundle
  and its fonts (rule 8) for a hover preview. Scrolling **re-measures** the card's
  anchor rather than dismissing it: dismissing while the pointer still rested on
  the link left the next mouse event free to schedule it again, which flickers.
- A **relative image** is rewritten to raw.githubusercontent.com, since a
  repo-relative `src` would otherwise resolve against the app's own origin.
- `#anchor` links scroll the reading pane, using the heading slugs.

### Full-window markdown gets an outline

`renderMarkdown` returns `{ parts, headings }`, and maximizing the preview turns
it into a reading view with a Contents panel (scroll-spy on the pane's own scroll
container). It is deliberately **only** offered when maximized: beside the editor
the pane can't spare the width, and the document is right there in the source. The
panel **floats over** the document rather than taking a column of it — a column
shifts the prose and re-fits every diagram in it each time the panel is toggled —
and it sits at the top right, directly under the window controls, so the panel and
the button that opens it are in the same place.

Filling the window covers the toolbar, so the reading view carries its own **Back**
button (`onBack`/`backLabel`) for the link trail described above. Anything else the
toolbar owns and a reader needs has to be repeated there for the same reason.
