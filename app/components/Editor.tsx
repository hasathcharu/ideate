'use client'

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ChangeSet, EditorState, Compartment, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  EditorView,
  GutterMarker,
  crosshairCursor,
  drawSelection,
  dropCursor,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type Panel,
  type ViewUpdate,
} from '@codemirror/view'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  getSearchQuery,
  setSearchQuery,
  SearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  closeSearchPanel,
} from '@codemirror/search'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from '@codemirror/commands'
import {
  StreamLanguage,
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { Undo2 } from 'lucide-react'
import { tags as t } from '@lezer/highlight'
import {
  changeAtLine,
  lineChanges,
  type LineChangeKind,
  type LineChangeRevert,
} from '@/lib/diff'
import Minimap from './Minimap'
import type { FileKind } from '@/lib/tree'
import type { TextEdit } from '@/lib/agentProtocol'
import { resolveEdits } from '@/lib/textEdit'

/** A small stream tokenizer that gives Mermaid source enough structure to read
 *  well in the editor. Not a full grammar — just keywords, arrows, labels. */
const mermaidLanguage = StreamLanguage.define<unknown>({
  languageData: { commentTokens: { line: '%%' } },
  token(stream) {
    if (stream.match(/%%.*/)) return 'comment'
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return 'string'
    if (stream.match(/\|[^|]*\|/)) return 'string' // |edge label|
    if (
      stream.match(
        /\b(?:graph|flowchart|sequenceDiagram|stateDiagram-v2|stateDiagram|classDiagram|erDiagram|xychart-beta|subgraph|end|direction|participant|actor|note|over|loop|alt|else|opt|par|and|rect|activate|deactivate|class|state|click|style|linkStyle|classDef|title|section|x-axis|y-axis|bar|line)\b/,
      )
    )
      return 'keyword'
    if (stream.match(/\b(?:TB|TD|BT|RL|LR)\b/)) return 'atom'
    if (stream.match(/:::/)) return 'operator'
    if (stream.match(/[-.=<>]{2,}[xo>]?/)) return 'operator' // -->, ---, ==>, -.->
    if (stream.match(/\d+(?:\.\d+)?/)) return 'number'
    if (stream.match(/[[\]{}()>]/)) return 'bracket'
    if (stream.match(/[A-Za-z_][\w-]*/)) return 'variableName'
    stream.next()
    return null
  },
})

/**
 * Syntax colors reference the shadcn design tokens (`--primary`, `--foreground`,
 * `--muted-foreground`) defined statically in globals.css, so highlighting stays consistent with
 * the app chrome.
 */
function highlightStyle(): HighlightStyle {
  const accent = 'var(--primary)'
  // Blend the accent toward the foreground for secondary token colors.
  const blend = (pct: number) =>
    `color-mix(in oklab, var(--primary) ${pct}%, var(--foreground))`
  return HighlightStyle.define([
    { tag: t.keyword, color: accent, fontWeight: '600' },
    { tag: t.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
    { tag: t.string, color: blend(55) },
    { tag: t.operator, color: accent },
    { tag: [t.atom, t.bool], color: blend(40) },
    { tag: t.number, color: blend(40) },
    { tag: t.variableName, color: 'var(--foreground)' },
    // Markdown tags. The mermaid tokenizer never emits these and the markdown
    // parser never emits most of the ones above, so one style serves both
    // languages and the two surfaces stay visually consistent.
    { tag: t.heading, color: accent, fontWeight: '700' },
    { tag: t.strong, color: 'var(--foreground)', fontWeight: '700' },
    { tag: t.emphasis, color: 'var(--foreground)', fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: [t.link, t.url], color: blend(55), textDecoration: 'underline' },
    { tag: t.monospace, color: blend(55) },
    { tag: t.quote, color: 'var(--muted-foreground)', fontStyle: 'italic' },
    { tag: t.list, color: accent },
    // The syntax marks themselves (`#`, `*`, list bullets, fence delimiters) —
    // muted so the prose they wrap stays the thing you read.
    {
      tag: [t.processingInstruction, t.contentSeparator],
      color: 'var(--muted-foreground)',
    },
  ])
}

/* ------------------------------------------------------------------ */
/* Link-target completion (markdown)                                   */
/* ------------------------------------------------------------------ */

/** The repository's file list and the open document's own path, so a link target
 *  can be completed *relative to this document* — which is how the link has to be
 *  written for both this app and GitHub to resolve it. */
interface RepoPaths {
  paths: readonly string[]
  docPath: string | null
}

const NO_PATHS: RepoPaths = { paths: [], docPath: null }

const setRepoPaths = StateEffect.define<RepoPaths>()

const repoPathsField = StateField.define<RepoPaths>({
  create: () => NO_PATHS,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setRepoPaths)) return effect.value
    return value
  },
})

/**
 * `to`, written relative to the directory `fromDir` — with as many `../` steps as
 * it takes. A sibling file is just its name.
 */
function relativeLink(fromDir: readonly string[], to: string): string {
  const parts = to.split('/')
  const name = parts.pop() ?? to
  let shared = 0
  while (
    shared < fromDir.length &&
    shared < parts.length &&
    fromDir[shared] === parts[shared]
  ) {
    shared++
  }
  const ups = fromDir.length - shared
  return [...Array<string>(ups).fill('..'), ...parts.slice(shared), name].join('/')
}

/**
 * Complete the target of a markdown link or image from the repository's own files: type `[text](`
 * and every file in the repo is offered, spelled relative to the document being edited.
 */
function linkTargetCompletions(context: CompletionContext): CompletionResult | null {
  const { paths, docPath } = context.state.field(repoPathsField, false) ?? NO_PATHS
  if (paths.length === 0) return null

  const line = context.state.doc.lineAt(context.pos)
  const before = line.text.slice(0, context.pos - line.from)
  const match = /!?\[[^\]]*\]\(([^()\s]*)$/.exec(before)
  if (!match) return null

  const typed = match[1] ?? ''
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(typed) ||
    typed.startsWith('//') ||
    typed.startsWith('#')
  ) {
    return null
  }
  // A leading `./` is kept as typed: the completion replaces only what follows it,
  // so the suggestions still match against the rest of the path.
  const kept = typed.startsWith('./') ? 2 : 0
  const dir = (docPath ?? '').split('/').slice(0, -1).filter(Boolean)

  return {
    from: context.pos - (typed.length - kept),
    options: paths
      .filter((path) => path !== docPath)
      .map((path) => {
        const label = relativeLink(dir, path)
        return {
          label,
          // The full repo path, as context for a link written relative to this document — but only
          // when it actually adds something.
          ...(label === path ? {} : { detail: path }),
          type: 'file',
        }
      }),
    validFor: /^[^()\s]*$/,
  }
}

/* ------------------------------------------------------------------ */
/* Languages                                                           */
/* ------------------------------------------------------------------ */

const markdownSupport = markdownLanguage()

/** Markdown, plus the link-target completions — registered as *language* data so
 *  the source is only consulted while editing markdown, and mermaid source is
 *  left with no completion behavior at all. */
const markdownExtensions = [
  markdownSupport,
  markdownSupport.language.data.of({ autocomplete: linkTargetCompletions }),
]

/** The language extension for a document kind. Excalidraw never reaches the text
 *  editor (it has its own canvas), so its scene JSON has no entry here. */
function languageFor(kind: FileKind) {
  return kind === 'markdown' ? markdownExtensions : mermaidLanguage
}

/* ------------------------------------------------------------------ */
/* Fold markers                                                        */
/* ------------------------------------------------------------------ */

const CHEVRON_DOWN =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6.5 4 4 4-4"/></svg>'
const CHEVRON_RIGHT =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6.5 4 4 4-4 4"/></svg>'

/**
 * The fold arrow beside a foldable line. CodeMirror's default is a bare `⌄`/`›` text glyph, which
 * renders at whatever the monospace font makes of it and sits on every foldable line at full
 * strength — visual noise down the whole gutter.
 */
function foldMarker(open: boolean): HTMLElement {
  const el = document.createElement('span')
  el.className = `cm-fold-marker ${open ? 'cm-fold-open' : 'cm-fold-closed'}`
  el.setAttribute('aria-hidden', 'true')
  el.innerHTML = open ? CHEVRON_DOWN : CHEVRON_RIGHT
  return el
}

/** Put the committed text back for one change block. */
function applyRevert(view: EditorView, revert: LineChangeRevert): void {
  const doc = view.state.doc
  const totalLines = doc.lines

  if (revert.toLine < revert.fromLine) {
    const atEnd = revert.fromLine > totalLines
    const insert = atEnd ? `\n${revert.text}` : `${revert.text}\n`
    const at = atEnd ? doc.length : doc.line(revert.fromLine).from
    view.dispatch({ changes: { from: at, insert }, scrollIntoView: true })
    return
  }

  const startLine = Math.max(1, Math.min(revert.fromLine, totalLines))
  const endLine = Math.max(startLine, Math.min(revert.toLine, totalLines))
  let from = doc.line(startLine).from
  let to = doc.line(endLine).to
  if (revert.text === '') {
    if (endLine < totalLines) to = doc.line(endLine + 1).from
    else if (startLine > 1) from = doc.line(startLine - 1).to
  }
  view.dispatch({ changes: { from, to, insert: revert.text }, scrollIntoView: true })
}

/**
 * What `basicSetup` bundles, spelled out — because three of its pieces need configuring rather than
 * accepting: `autocompletion`, which must be included exactly once for the language-scoped link
 * completions above to reach it, and `foldGutter` (see {@link foldMarker}), which is added at the
 * mount site so it lands to the *right* of the dirty gutter — the gutters render in extension
 * order, and the change bar belongs beside the line numbers.
 */
const baseSetup = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  // `icons: false`: CodeMirror renders an icon slot for every row and only ships glyphs for its own
  // completion types, of which `file` is not one — so the markdown link completions got an empty
  // box indenting every path.
  autocompletion({ icons: false }),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  repoPathsField,
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
  ]),
]

interface EditorExtensionOptions {
  kind: FileKind
  wrap: boolean
  dark: boolean
  language: Compartment
  wrapping: Compartment
  theme: Compartment
  highlighting: Compartment
  onDoubleClick: (event: MouseEvent, view: EditorView) => boolean
  onUpdate: (update: ViewUpdate) => void
}

/**
 * The cohesive CodeMirror extension groups for one editor state. Keeping this
 * assembly outside the React mount effect makes the gutter order and the single
 * autocompletion/search setup explicit without moving document ownership into an
 * effect.
 */
function createEditorExtensions({
  kind,
  wrap,
  dark,
  language,
  wrapping,
  theme,
  highlighting,
  onDoubleClick,
  onUpdate,
}: EditorExtensionOptions): Extension[] {
  const documentExtensions: Extension[] = [
    language.of(languageFor(kind)),
    wrapping.of(wrap ? EditorView.lineWrapping : []),
    theme.of(editorTheme(dark)),
    highlighting.of(syntaxHighlighting(highlightStyle())),
  ]
  const interactionExtensions: Extension[] = [
    search({ top: true, createPanel: createSearchPanel }),
    keymap.of([indentWithTab, { key: 'Mod-/', run: toggleComment }]),
    EditorView.domEventHandlers({ dblclick: onDoubleClick }),
    EditorView.updateListener.of(onUpdate),
  ]

  return [
    baseSetup,
    // Gutters render in extension order: changes sit beside line numbers and
    // fold arrows stay outside the change bar.
    lineChangeGutter,
    foldGutter({ markerDOM: foldMarker }),
    documentExtensions,
    interactionExtensions,
  ]
}

/* ------------------------------------------------------------------ */
/* Dirty gutter (uncommitted changes, VS Code style)                   */
/* ------------------------------------------------------------------ */

/**
 * The bar beside the line numbers marking lines that differ from what is committed — added,
 * modified, or sitting where lines were deleted.
 */
const setLineChanges = StateEffect.define<Map<number, LineChangeKind>>()

const lineChangeField = StateField.define<Map<number, LineChangeKind>>({
  create: () => new Map(),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLineChanges)) return effect.value
    return value
  },
})

class ChangeMarker extends GutterMarker {
  constructor(private readonly kind: LineChangeKind) {
    super()
  }
  override eq(other: ChangeMarker): boolean {
    return other.kind === this.kind
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = `cm-change cm-change-${this.kind}`
    el.title =
      this.kind === 'added'
        ? 'Added since the last commit'
        : this.kind === 'modified'
          ? 'Modified since the last commit'
          : 'Lines deleted here since the last commit'
    return el
  }
}

const CHANGE_MARKERS: Record<LineChangeKind, ChangeMarker> = {
  added: new ChangeMarker('added'),
  modified: new ChangeMarker('modified'),
  removed: new ChangeMarker('removed'),
}

/**
 * Where a click on the gutter is delivered. A facet would be the idiomatic way to pass a handler
 * into an extension, but the extension array is built once at module scope and the handler has to
 * reach React state that changes on every render — so the view carries a mutable slot instead, set
 * by the component.
 */
const clickHandlers = new WeakMap<EditorView, (line: number) => void>()

const lineChangeGutter = [
  lineChangeField,
  gutter({
    class: 'cm-change-gutter',
    lineMarker(view, line) {
      const changes = view.state.field(lineChangeField, false)
      if (!changes || changes.size === 0) return null
      const kind = changes.get(view.state.doc.lineAt(line.from).number)
      return kind ? CHANGE_MARKERS[kind] : null
    },
    // The gutter is redrawn on doc changes anyway; this covers a new baseline
    // arriving without the document itself changing (e.g. right after a commit).
    lineMarkerChange: (update) =>
      update.transactions.some((tr) => tr.effects.some((e) => e.is(setLineChanges))),
    domEventHandlers: {
      mousedown(view, line) {
        const changes = view.state.field(lineChangeField, false)
        const number = view.state.doc.lineAt(line.from).number
        if (!changes?.has(number)) return false
        clickHandlers.get(view)?.(number)
        // Handled: the click must not also move the cursor, which would scroll
        // the peek popup's own line out from under it.
        return true
      },
    },
  }),
]

/* Inline icons for the custom search panel (CodeMirror DOM is not React, so we
 * hand-build small SVGs rather than use lucide components). */
const ARROW_UP =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5V4M4 7.5 8 3.5l4 4"/></svg>'
const ARROW_DOWN =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5V12M4 8.5l4 4 4-4"/></svg>'
const CLOSE_X =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>'

/**
 * A VSCode-styled search / replace panel. Replaces CodeMirror's default checkbox options with icon
 * toggles (Aa / ab̲ / .*), uses up/down arrows for previous / next, drops the "all"
 * (select-all-matches) button, and capitalizes the Replace / Replace All actions.
 */
function createSearchPanel(view: EditorView): Panel {
  const query = () => getSearchQuery(view.state)

  const commit = (patch: Partial<ConstructorParameters<typeof SearchQuery>[0]>) => {
    const q = query()
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: q.search,
          replace: q.replace,
          caseSensitive: q.caseSensitive,
          wholeWord: q.wholeWord,
          regexp: q.regexp,
          ...patch,
        }),
      ),
    })
  }

  const searchField = document.createElement('input')
  searchField.className = 'cm-textfield'
  searchField.placeholder = 'Find'
  searchField.setAttribute('main-field', 'true')
  searchField.setAttribute('aria-label', 'Find')
  searchField.value = query().search
  searchField.addEventListener('input', () => commit({ search: searchField.value }))

  const replaceField = document.createElement('input')
  replaceField.className = 'cm-textfield'
  replaceField.placeholder = 'Replace'
  replaceField.setAttribute('aria-label', 'Replace')
  replaceField.value = query().replace
  replaceField.addEventListener('input', () => commit({ replace: replaceField.value }))

  const toggles: Array<() => void> = []
  function makeToggle(
    html: string,
    title: string,
    get: () => boolean,
    set: (v: boolean) => void,
  ): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'cm-search-toggle'
    b.title = title
    b.setAttribute('aria-label', title)
    b.innerHTML = html
    const sync = () => b.setAttribute('aria-pressed', String(get()))
    sync()
    toggles.push(sync)
    b.addEventListener('click', () => {
      set(!get())
      sync()
      searchField.focus()
    })
    return b
  }

  function iconButton(html: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'cm-search-nav'
    b.title = title
    b.setAttribute('aria-label', title)
    b.innerHTML = html
    b.addEventListener('click', () => run())
    return b
  }

  function textButton(label: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'cm-button'
    b.textContent = label
    b.addEventListener('click', () => run())
    return b
  }

  const caseToggle = makeToggle(
    'Aa',
    'Match Case',
    () => query().caseSensitive,
    (v) => commit({ caseSensitive: v }),
  )
  const wordToggle = makeToggle(
    '<u>ab</u>',
    'Match Whole Word',
    () => query().wholeWord,
    (v) => commit({ wholeWord: v }),
  )
  const regexToggle = makeToggle(
    '.*',
    'Use Regular Expression',
    () => query().regexp,
    (v) => commit({ regexp: v }),
  )

  const prevBtn = iconButton(ARROW_UP, 'Previous Match', () => findPrevious(view))
  const nextBtn = iconButton(ARROW_DOWN, 'Next Match', () => findNext(view))
  const closeBtn = iconButton(CLOSE_X, 'Close', () => {
    closeSearchPanel(view)
    view.focus()
  })
  closeBtn.classList.add('cm-search-close')

  const searchRow = document.createElement('div')
  searchRow.className = 'cm-search-row'
  searchRow.append(
    searchField,
    caseToggle,
    wordToggle,
    regexToggle,
    prevBtn,
    nextBtn,
    closeBtn,
  )

  const replaceRow = document.createElement('div')
  replaceRow.className = 'cm-search-row'
  replaceRow.append(
    replaceField,
    textButton('Replace', () => replaceNext(view)),
    textButton('Replace All', () => replaceAll(view)),
  )

  const dom = document.createElement('div')
  dom.className = 'cm-search'
  dom.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSearchPanel(view)
      view.focus()
    } else if (e.key === 'Enter' && e.target === searchField) {
      e.preventDefault()
      if (e.shiftKey) findPrevious(view)
      else findNext(view)
    } else if (e.key === 'Enter' && e.target === replaceField) {
      e.preventDefault()
      replaceNext(view)
    }
  }
  dom.append(searchRow, replaceRow)

  return {
    dom,
    top: true,
    /** Focus and select the find field as the panel appears. */
    mount() {
      searchField.focus()
      searchField.select()
    },
    update(update) {
      const q = getSearchQuery(update.state)
      if (document.activeElement !== searchField && searchField.value !== q.search) {
        searchField.value = q.search
      }
      if (document.activeElement !== replaceField && replaceField.value !== q.replace) {
        replaceField.value = q.replace
      }
      for (const sync of toggles) sync()
    },
  }
}

function editorTheme(dark: boolean) {
  // Colors reference the shadcn design tokens, so the editor surface matches the
  // rest of the site.
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: '13px',
        backgroundColor: 'transparent',
        color: 'var(--foreground)',
      },
      '.cm-scroller': {
        fontFamily:
          "var(--font-mono, ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace)",
        lineHeight: '1.6',
      },
      '.cm-content': { padding: '12px 0', caretColor: 'var(--primary)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--primary)' },
      // The gutter sits on the editor's own surface, like VS Code's. On
      // `--secondary` (a mid-tone from the diagram palette) the line numbers were
      // muted text on a surface `--muted-foreground` is not measured against — as
      // low as 2:1 on some themes — and it drew a band down the side of the pane.
      '.cm-gutters': {
        border: 'none',
        backgroundColor: 'var(--background)',
        color: 'var(--muted-foreground)',
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--foreground) 6%, transparent)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'color-mix(in srgb, var(--foreground) 18%, transparent)',
      },
      // Blended into the *page*, not into transparency.
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        {
          backgroundColor: 'color-mix(in srgb, var(--primary) 28%, var(--background))',
        },
      // Search hits and other occurrences of the selected word.
      '.cm-searchMatch': {
        backgroundColor: 'color-mix(in srgb, var(--primary) 22%, var(--background))',
        outline: '1px solid color-mix(in srgb, var(--primary) 45%, transparent)',
        borderRadius: '2px',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'color-mix(in srgb, var(--primary) 45%, var(--background))',
      },
      '.cm-selectionMatch': {
        backgroundColor: 'color-mix(in srgb, var(--foreground) 14%, transparent)',
        borderRadius: '2px',
      },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'color-mix(in srgb, var(--primary) 30%, transparent)',
        outline: 'none',
      },
      '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
        backgroundColor: 'color-mix(in srgb, var(--destructive) 30%, transparent)',
      },
      // Tooltips (the completion popup, and anything else CodeMirror floats).
      '.cm-tooltip': {
        backgroundColor: 'var(--popover)',
        color: 'var(--popover-foreground)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        boxShadow: '0 4px 12px color-mix(in srgb, var(--foreground) 12%, transparent)',
        overflow: 'hidden',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily:
          "var(--font-mono, ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace)",
        fontSize: '12px',
        maxHeight: '16rem',
        padding: '4px',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 6px',
        borderRadius: '6px',
        color: 'var(--popover-foreground)',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--accent)',
        color: 'var(--accent-foreground)',
      },
      // The matched substring. CodeMirror underlines it; the app's own filtered
      // lists bolden instead, and an underline inside a file path reads as part of
      // the path.
      '.cm-completionMatchedText': {
        textDecoration: 'none',
        fontWeight: '700',
        color: 'var(--primary)',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText': {
        color: 'inherit',
      },
      // The icon column. `autocompletion({ icons: false })` stops it being rendered at all; this
      // collapses it if it ever is, because the geometry of the row shouldn't depend on that flag
      // holding.
      '.cm-completionIcon': {
        display: 'none',
      },
      '.cm-completionLabel': { flex: '1 1 auto', minWidth: '0' },
      '.cm-completionDetail': {
        flex: '0 1 auto',
        minWidth: '0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontStyle: 'normal',
        fontSize: '11px',
        color: 'var(--muted-foreground)',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail': {
        color: 'inherit',
        opacity: '0.75',
      },
      // Search / replace panel (⌘F): custom VSCode-styled panel themed with the app's design tokens
      // instead of CodeMirror's default light chrome.
      '.cm-panels': {
        backgroundColor: 'var(--popover)',
        color: 'var(--popover-foreground)',
      },
      '.cm-panels.cm-panels-top': {
        position: 'absolute',
        // Offset by margin, not by `top`. CodeMirror's panel manager writes `style.top = "0"`
        // **inline** on this element when it creates the group, and an inline declaration beats any
        // rule here — a `top` of our own was simply ignored (`right` is untouched by it, which is
        // why that one works).
        marginTop: '10px',
        right: '10px',
        left: 'auto',
        zIndex: '15',
        width: 'auto',
        maxWidth: 'calc(100% - 20px)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        boxShadow: '0 8px 24px -8px rgb(0 0 0 / 0.35)',
        overflow: 'hidden',
      },
      '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
      '.cm-panel.cm-search': {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        // Wide enough that the find field still reads as a field once its three
        // toggles and three buttons have taken their share of the row — and
        // fixed, or the box jitters as the query is typed.
        width: '380px',
        maxWidth: '100%',
        padding: '8px 10px',
        fontSize: '12px',
      },
      '.cm-search-row': { display: 'flex', alignItems: 'center', gap: '4px' },
      // A floor rather than `min-width: 0`: the panel shrinks with a narrow
      // editor pane, and with the fields free to collapse they were the first
      // thing to go — leaving a row of toggles around a find box too small to
      // show a single character. Overflowing the panel is the better failure.
      '.cm-search-row .cm-textfield': { flex: '1 1 auto', minWidth: '7rem' },
      '.cm-textfield': {
        backgroundColor: 'var(--input)',
        color: 'var(--foreground)',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        padding: '4px 8px',
        fontSize: '12px',
      },
      '.cm-textfield:focus': { outline: 'none', borderColor: 'var(--ring)' },
      '.cm-search-toggle': {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: '22px',
        height: '22px',
        padding: '0 4px',
        fontSize: '12px',
        fontFamily:
          'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
        lineHeight: '1',
        color: 'var(--muted-foreground)',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: '4px',
        cursor: 'pointer',
      },
      '.cm-search-toggle:hover': { backgroundColor: 'var(--accent)' },
      '.cm-search-toggle[aria-pressed=true]': {
        color: 'var(--foreground)',
        backgroundColor: 'color-mix(in srgb, var(--primary) 25%, transparent)',
        borderColor: 'color-mix(in srgb, var(--primary) 45%, transparent)',
      },
      '.cm-search-nav': {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '22px',
        height: '22px',
        padding: '0',
        color: 'var(--muted-foreground)',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: '4px',
        cursor: 'pointer',
      },
      '.cm-search-nav:hover': {
        backgroundColor: 'var(--accent)',
        color: 'var(--foreground)',
      },
      '.cm-search-close': { marginLeft: 'auto' },
      '.cm-button': {
        backgroundColor: 'var(--secondary)',
        backgroundImage: 'none',
        color: 'var(--secondary-foreground)',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        padding: '4px 10px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      '.cm-button:hover': { backgroundColor: 'var(--accent)' },
    },
    { dark },
  )
}

/** The imperative surface Agent Link drives (`lib/agentLink.ts`). */
/** How many recent emissions the echo guard remembers. See `emittedRef`. */
const EMITTED_HISTORY = 8

export interface EditorHandle {
  /** Apply anchored replacements as one transaction, scrolling the last one into view. */
  applyEdits: (edits: readonly TextEdit[]) => string
  /** Replace the whole document as one deliberate, undoable transaction. */
  replaceText: (text: string) => string
  /** 1-based cursor position, for `ideate_status`. */
  cursor: () => { line: number; column: number } | null
  /** Put the cursor on a 1-based line and scroll it into view — the editor half
   *  of the scroll sync with the markdown preview. Out-of-range lines are clamped
   *  rather than rejected: the caller's line comes from a rendered document that
   *  may be a render or two behind the text. */
  revealLine: (line: number) => void
}

export interface EditorProps {
  documentId: string
  value: string
  onChange: (value: string) => void
  dark: boolean
  /** Which grammar to highlight with. Mermaid source and markdown prose share
   *  this one editor, so the language is swapped through a compartment rather
   *  than by remounting — a remount would drop undo history and cursor position
   *  on every file switch. */
  kind?: FileKind
  /** Soft-wrap long lines instead of scrolling horizontally. Swapped through a
   *  compartment for the same reason the language is: toggling it must not cost
   *  the undo history. */
  wrap?: boolean
  /** The committed content of the open document, which the gutter marks the
   *  working copy's divergence from. Null (a file with nothing saved behind it, or
   *  the untitled document) leaves the gutter empty — there is nothing to diverge
   *  from, so marking every line as new would be noise. */
  baseline?: string | null
  /** Every file in the workspace — the connected repository, or local mode's own
   *  files — for completing markdown link targets. Empty only when there is no
   *  workspace at all, which disables the completions. */
  filePaths?: readonly string[]
  /** Repo-relative path of the open document, so completed links are written
   *  relative to it. */
  docPath?: string | null
  /** Show the viewfinder column (the whole document at a glance) on the right. */
  minimap?: boolean
  /** Double-clicking a line reports its 1-based number, so the preview can scroll
   *  to whatever that line renders as. Double-click still selects the word under
   *  the pointer — the sync rides along with the existing gesture rather than
   *  taking it over. */
  onRevealPreview?: (line: number) => void
  /** Handle for Agent Link. Passed as an ordinary prop — React 19 treats
   *  `ref` as one for function components, so no `forwardRef` wrapper is needed. */
  ref?: React.Ref<EditorHandle>
}

export default function Editor({
  documentId,
  value,
  onChange,
  dark,
  kind = 'mermaid',
  wrap = false,
  baseline = null,
  filePaths,
  docPath = null,
  minimap = false,
  onRevealPreview,
  ref,
}: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const statesRef = useRef(new Map<string, EditorState>())
  const currentIdRef = useRef(documentId)
  const applyingExternalRef = useRef(false)
  const extensionsRef = useRef<Extension[]>([])
  const onChangeRef = useRef(onChange)
  // Behind a ref for the same reason `onChange` is: the extension array is built
  // once at mount, and this handler changes identity on every parent render.
  const onRevealPreviewRef = useRef(onRevealPreview)
  /**
   * Documents this editor has emitted that may still be in flight as a stale `value` prop, newest
   * last.
   */
  const emittedRef = useRef<string[]>([value])
  const themeCompartment = useRef(new Compartment())
  const highlightCompartment = useRef(new Compartment())
  const languageCompartment = useRef(new Compartment())
  const wrapCompartment = useRef(new Compartment())

  onChangeRef.current = onChange
  onRevealPreviewRef.current = onRevealPreview

  // Mount once.
  useEffect(() => {
    if (!hostRef.current) return
    const documentStates = statesRef.current
    const extensions = createEditorExtensions({
      kind,
      wrap,
      dark,
      language: languageCompartment.current,
      wrapping: wrapCompartment.current,
      theme: themeCompartment.current,
      highlighting: highlightCompartment.current,
      onDoubleClick(event, view) {
        const reveal = onRevealPreviewRef.current
        if (!reveal) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos !== null) reveal(view.state.doc.lineAt(pos).number)
        // Preserve CodeMirror's ordinary word-selection behavior.
        return false
      },
      onUpdate(update) {
        if (!update.docChanged || applyingExternalRef.current) return
        const doc = update.state.doc.toString()
        emittedRef.current = [...emittedRef.current, doc].slice(-EMITTED_HISTORY)
        onChangeRef.current(doc)
        measureScrollRef.current()
      },
    })
    extensionsRef.current = extensions
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({ doc: value, extensions }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
      documentStates.clear()
    }
    // Mount-only; `value`/`dark` changes handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Preserve each document's undo stack and selection while reusing the same DOM view.
  // Leaving text mode or entering Diff unmounts this component and discards the cache.
  useEffect(() => {
    const view = viewRef.current
    if (!view || currentIdRef.current === documentId) return
    statesRef.current.set(currentIdRef.current, view.state)
    currentIdRef.current = documentId
    emittedRef.current = []
    const state = statesRef.current.get(documentId) ?? EditorState.create({ doc: value, extensions: extensionsRef.current })
    view.setState(state)
  }, [documentId, value])

  // Reconcile external value changes (open file, recover version, start over).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const echo = emittedRef.current.lastIndexOf(value)
    if (echo !== -1) {
      // Our own output coming back around. Drop it and everything older, and
      // leave the document alone — it is already at least this new.
      emittedRef.current = emittedRef.current.slice(echo + 1)
      return
    }
    // Genuinely external: replace the document wholesale, and forget the
    // emission history, which now describes a document that no longer exists.
    emittedRef.current = [value]
    applyingExternalRef.current = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    })
    applyingExternalRef.current = false
  }, [value, documentId])

  // Swap the grammar when the open document's kind changes (e.g. opening a .md
  // after a .mmd), without tearing down the editor.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: languageCompartment.current.reconfigure(languageFor(kind)),
    })
  }, [kind, documentId])

  // Recompute the dirty gutter when the document or the committed baseline changes.
  const [changes, setChanges] = useState<Map<number, LineChangeKind>>(() => new Map())
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const push = (next: Map<number, LineChangeKind>) => {
      setChanges(next)
      viewRef.current?.dispatch({ effects: setLineChanges.of(next) })
    }
    if (baseline === null) {
      push(new Map())
      return
    }
    const id = window.setTimeout(() => push(lineChanges(baseline, value)), 200)
    return () => window.clearTimeout(id)
  }, [value, baseline])

  /* ---------------------------------------------------------------- */
  /* Viewfinder                                                        */
  /* ---------------------------------------------------------------- */

  const [scrollInfo, setScrollInfo] = useState({
    top: 0,
    height: 0,
    scrollHeight: 0,
  })
  // Set by the effect below and called from the update listener, so a document
  // change re-measures without the listener having to be rebuilt for it.
  const measureScrollRef = useRef<() => void>(() => {})

  useEffect(() => {
    const view = viewRef.current
    if (!view || !minimap) return
    const scroller = view.scrollDOM
    let frame = 0
    const measure = () => {
      frame = 0
      setScrollInfo((prev) =>
        prev.top === scroller.scrollTop &&
        prev.height === scroller.clientHeight &&
        prev.scrollHeight === scroller.scrollHeight
          ? prev
          : {
              top: scroller.scrollTop,
              height: scroller.clientHeight,
              scrollHeight: scroller.scrollHeight,
            },
      )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measureScrollRef.current = schedule
    // The first measurement is synchronous, not scheduled: a frame callback never
    // runs while the tab is in the background, which would leave the viewfinder
    // with a zero-height viewport marker until something else nudged it.
    measure()
    scroller.addEventListener('scroll', schedule, { passive: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(scroller)
    return () => {
      measureScrollRef.current = () => {}
      scroller.removeEventListener('scroll', schedule)
      ro.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [minimap])

  const scrollEditorTo = useCallback((top: number) => {
    const scroller = viewRef.current?.scrollDOM
    if (scroller) scroller.scrollTop = top
  }, [])

  // Feed the link completions. The file list is the app's state, like the
  // baseline, so it arrives as an effect rather than being derived in-editor.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: setRepoPaths.of({ paths: filePaths ?? [], docPath }),
    })
  }, [filePaths, docPath, documentId])

  // Toggle soft wrapping in place.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    })
  }, [wrap, documentId])

  /* ---------------------------------------------------------------- */
  /* Peek popup (click a gutter marker)                                */
  /* ---------------------------------------------------------------- */

  const [peekLine, setPeekLine] = useState<number | null>(null)
  const [peekTop, setPeekTop] = useState(0)

  // The block of changed lines behind the clicked marker. Recomputed with the
  // document, so a peek that the latest edit resolved closes itself.
  const peek = useMemo(() => {
    if (peekLine === null || baseline === null) return null
    return changeAtLine(baseline, value, peekLine)
  }, [peekLine, baseline, value])

  const revertPeek = useCallback(() => {
    const view = viewRef.current
    if (!view || !peek) return
    applyRevert(view, peek.revert)
    // The block no longer exists, so there is nothing left to peek at.
    setPeekLine(null)
    view.focus()
  }, [peek])

  const measurePeek = useCallback((line: number) => {
    const view = viewRef.current
    const host = hostRef.current
    if (!view || !host) return
    const doc = view.state.doc
    const target = doc.line(Math.min(Math.max(line, 1), doc.lines))
    const coords = view.coordsAtPos(target.from)
    if (!coords) return
    setPeekTop(coords.bottom - host.getBoundingClientRect().top + 2)
  }, [])

  // Register the gutter's click target. The handler is stable, so this runs once.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    clickHandlers.set(view, (line) => {
      setPeekLine((prev) => (prev === line ? null : line))
      measurePeek(line)
    })
    return () => {
      clickHandlers.delete(view)
    }
  }, [measurePeek])

  // Keep the popup pinned to its line while the editor scrolls, and dismiss it on
  // Escape or a click outside it.
  useEffect(() => {
    if (peekLine === null) return
    const view = viewRef.current
    const scroller = view?.scrollDOM
    const onScroll = () => measurePeek(peekLine)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPeekLine(null)
    }
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      // A click on the gutter is the toggle itself; leave it to that handler.
      if (target?.closest('.cm-change-gutter') || target?.closest('.cm-peek')) return
      setPeekLine(null)
    }
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      scroller?.removeEventListener('scroll', onScroll)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [peekLine, measurePeek])

  // Nothing to peek at once the file is committed or reverted.
  useEffect(() => {
    if (baseline === null) setPeekLine(null)
  }, [baseline])

  // React to light/dark switches without remounting. The highlight style is
  // CSS-variable based (reads :root tokens), so only the editor theme — which
  // carries CodeMirror's own `dark` flag — needs reconfiguring.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartment.current.reconfigure(editorTheme(dark)),
    })
  }, [dark, documentId])

  // Agent Link's door into this editor (see `EditorHandle`). Mount-stable:
  // everything it needs is behind `viewRef`, so the handle identity never changes
  // and the bridge never has to re-read it.
  useImperativeHandle(
    ref,
    () => ({
      applyEdits: (edits) => {
        const view = viewRef.current
        if (!view) throw new Error('The text editor is not mounted.')
        const changes = resolveEdits(view.state.doc.toString(), edits)
        // Resolved against the pre-transaction document, which is exactly what a
        // ChangeSet consumes — so this is one atomic dispatch and one undo step,
        // however many anchors were in the batch.
        const set = ChangeSet.of(changes, view.state.doc.length)
        const last = changes[changes.length - 1]!
        // Select the text the last edit inserted, so the human watching sees
        // where the agent worked. `mapPos` with assoc -1 lands at the start of
        // the insertion; doing this arithmetic by hand would mean re-deriving the
        // net shift of every preceding change.
        const anchor = set.mapPos(last.from, -1)
        view.dispatch({
          changes: set,
          selection: { anchor, head: anchor + last.insert.length },
          scrollIntoView: true,
        })
        return view.state.doc.toString()
      },
      replaceText: (text) => {
        const view = viewRef.current
        if (!view) throw new Error('The text editor is not mounted.')
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: Math.min(text.length, view.state.selection.main.head) },
        })
        return view.state.doc.toString()
      },
      cursor: () => {
        const view = viewRef.current
        if (!view) return null
        const head = view.state.selection.main.head
        const line = view.state.doc.lineAt(head)
        return { line: line.number, column: head - line.from + 1 }
      },
      revealLine: (line) => {
        const view = viewRef.current
        if (!view) return
        const doc = view.state.doc
        const target = doc.line(Math.min(Math.max(Math.round(line), 1), doc.lines))
        // Move the cursor as well as scrolling: centring a line and leaving the
        // caret behind means the next keystroke scrolls straight back to wherever
        // it was, undoing the jump.
        view.dispatch({
          selection: { anchor: target.from },
          effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
        })
        // Deliberately no `focus()` — the human is reading the document and
        // clicked in it; stealing the caret out of the pane they are pointing at
        // is not what a scroll sync is for.
      },
    }),
    [],
  )

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        <div ref={hostRef} className="editor-host" />
        {peek ? (
          <div
            className="cm-peek absolute right-3 left-12 z-20 max-h-64 overflow-auto rounded-md border bg-popover font-mono text-xs shadow-lg"
            style={{ top: peekTop }}
          >
            <div className="flex items-center justify-between gap-2 border-b bg-muted px-2 py-1 text-[11px] text-muted-foreground">
              <span>
                {peek.kind === 'added'
                  ? 'Added since the last commit'
                  : peek.kind === 'removed'
                    ? 'Deleted since the last commit'
                    : 'Changed since the last commit'}
              </span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans hover:bg-accent hover:text-accent-foreground"
                  onClick={revertPeek}
                  title="Discard this change and restore the committed text"
                >
                  <Undo2 className="size-3" /> Revert
                </button>
                <button
                  type="button"
                  className="rounded px-1 hover:bg-accent hover:text-accent-foreground"
                  onClick={() => setPeekLine(null)}
                  aria-label="Close"
                >
                  ✕
                </button>
              </span>
            </div>
            {peek.lines.map((line, i) => (
              <div
                key={i}
                className={
                  line.type === 'add'
                    ? 'flex bg-diff-add/12'
                    : line.type === 'remove'
                      ? 'flex bg-diff-remove/12'
                      : 'flex'
                }
              >
                <span
                  className={
                    line.type === 'add'
                      ? 'w-4 flex-none px-1 text-diff-add select-none'
                      : 'w-4 flex-none px-1 text-diff-remove select-none'
                  }
                >
                  {line.type === 'add' ? '+' : '−'}
                </span>
                <span className="min-w-0 flex-1 pr-2 break-all whitespace-pre-wrap">
                  {line.text || ' '}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {minimap ? (
        <Minimap
          text={value}
          changes={baseline === null ? null : changes}
          scroll={scrollInfo}
          onScrollTo={scrollEditorTo}
        />
      ) : null}
    </div>
  )
}
