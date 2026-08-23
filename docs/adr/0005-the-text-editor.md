# 0005. One CodeMirror instance, the gutter order, and the two-pane line sync

**Status** accepted &nbsp;·&nbsp; **Touches** `app/components/Editor.tsx, app/components/Minimap.tsx, app/components/MarkdownPreview.tsx`

The invariants this record justifies are listed in [`CLAUDE.md`](../../CLAUDE.md). This file holds the reasoning behind them — read it before changing any of them, and update it here when a decision actually changes.

---

## The text editor

`components/Editor.tsx` is one CodeMirror instance for both text kinds, with every
per-document setting swapped through a `Compartment` (language, theme, soft wrap)
rather than by remounting — a remount drops undo history and cursor position on
every file switch. The line-wrap toggle is an app preference
(`AppConfig.wrapLines`), so it survives reloads.

It **does not use `basicSetup`**: that bundle is spelled out as `baseSetup` because
three of its pieces need configuring rather than accepting.

- `autocompletion()` must appear **exactly once**, so the markdown link-target
  completions can be registered as *language data* and reach it. Typing
  `[text](` offers every file in the repo, written relative to the document being
  edited (`relativeLink`), so the result is a link both this app and GitHub
  resolve. The file list and the document's path arrive as a `StateEffect`, like
  the diff baseline — they are the app's state, not the editor's. It is configured
  `{ icons: false }`: CodeMirror renders an icon slot per row but only ships glyphs
  for its own completion types, and `file` is not one, so every path was indented
  by an empty box. And a completion's `detail` is set **only when it differs from
  the label** — a sibling file relativizes to its own name, and for a document at
  the repo root every path does, so an unconditional `detail` printed the same
  string twice on every row.
- `foldGutter` gets a real chevron (`foldMarker`) instead of CodeMirror's bare
  `⌄`/`›` glyph, hidden until the gutter is hovered unless the line is actually
  folded. It is added **at the mount site, after the dirty gutter**: gutters render
  in extension order, and the change bar belongs beside the line numbers.
- `defaultHighlightStyle` and the lint gutter are dropped — this editor has its
  own highlight style, and nothing here lints.

Anything added to that list has to keep the gutter order (line numbers → changes →
folds) and the single `autocompletion()`.

**Every surface CodeMirror paints itself has to be named in `editorTheme`.** The
pieces it does *not* name fall back to a stock theme whose colors are literals
picked against a white editor, and those are what looked broken on dark palettes:
`.cm-searchMatch` (pale yellow), `.cm-selectionMatch` (pale green), and
`.cm-tooltip` — the completion popup — a light card with a `#17c` selection bar.
The tooltip is appended outside the editor's DOM but still receives the editor's
theme classes, so theme rules do reach it. Two related rules:

- **`dark` must be the palette's real mode** (`resolveThemeMode`), not a constant.
  Pinned to `false` a dark palette got the light defaults underneath everything
  the theme didn't override.
- **Translucent accents blend into `--background`, not into transparency.** A
  translucent bright accent over a dark theme composites *toward the accent*, which
  is what washed the selection (and the selected text) out. Mixing into the page
  color keeps a dark palette's selection dark at the same visual strength.

The gutter sits on `--background` rather than `--secondary` for both reasons: the
line numbers are `--muted-foreground`, which is measured against the page (see the
contrast floor), and a mid-tone band down the side of the pane was never the
intent.

## Double-click scrolls the other pane (markdown)

`lib/markdown.ts` stamps every rendered block with the 1-based source line it came
from (`SOURCE_LINE_ATTR` = `data-md-line`), and `MarkdownPreview` + `Editor` each
expose a `revealLine` on their imperative handle; `AppShell` wires the two
double-click handlers to each other's handle. Four things are deliberate:

- **markdown-it already knows the mapping** — every block token carries a `map`.
  Re-deriving it by counting rendered elements is not made correct by care: raw
  HTML, footnotes and nested lists all break the correspondence.
- **The block token stream is flat** (only *inline* children nest), so one core
  rule reaches a paragraph inside a list item inside a blockquote, and the sync
  gets that granularity for free. Closing tokens and `inline` tokens are skipped —
  the latter renders its children, not a tag.
- **Fences are stamped from the other end.** They render as placeholders, so the
  line travels through `FoundFence`/`FoundCode` and is grafted on with
  `withSourceLine` (or, for a standalone diagram, carried as a field on the
  `MarkdownPart` and handed to `DiagramViewport`'s `sourceLine`).
- **It is imperative, not a prop.** A jump is an event: the same line
  double-clicked twice must jump twice, which an unchanged prop cannot express —
  and the nonce workaround re-renders the whole document, every embedded diagram
  included, on each jump.

Neither side calls `focus()`, and the editor's `dblclick` handler returns `false`
so the double-click still selects a word. The sync rides along with the existing
gesture rather than taking it over.

Beside the editor sits the **viewfinder** (`components/Minimap.tsx`,
`AppConfig.minimap`): the whole document compressed into a 64px column, with the
visible region marked and the uncommitted changes banded across it. Three things
about it are deliberate:

- **It is a canvas.** A thousand-line file is a thousand marks, and a thousand
  absolutely-positioned divs would cost more to lay out than the editor itself.
- **The scale is fixed at 3px per line, and the map slides** when the document is
  taller than the column — the same thing VS Code does. Fitting every line into the
  available height instead was the obvious first implementation and it is useless
  past a few hundred lines: each line collapses to a sub-pixel smear. The slide is
  driven by the editor's *scroll progress* (`overflow * progress`), not its scroll
  offset, so the map reaches its own end exactly when the editor reaches the
  document's — and the pointer→document mapping has to add `mapTop` back in, or
  clicking a mark scrolls somewhere else once the map has slid. Only the visible
  slice is drawn, so cost per frame is flat in file size.
- **Its colors are read from computed style at draw time** (`color`, `--diff-*`),
  so it follows the active palette with none of it duplicated here. A theme change
  rewrites custom properties on `<body>` without changing a single prop, so a
  `MutationObserver` on that element is what triggers the redraw.

The scroll geometry comes from the CodeMirror scroller (`scrollDOM`), not from a
line count, so soft-wrapped lines don't throw the viewport marker off; a document
change re-measures through a ref the update listener calls, rather than by
rebuilding the listener on every keystroke. The *first* measurement is synchronous
rather than scheduled — a frame callback never runs while the tab is in the
background, which would otherwise leave the viewport marker at zero height until
something else nudged it.
