'use client'

import { useEffect, useRef } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, type Panel } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import {
  search,
  getSearchQuery,
  setSearchQuery,
  SearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  closeSearchPanel,
} from '@codemirror/search'
import { indentWithTab } from '@codemirror/commands'
import {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/** A small stream tokenizer that gives Mermaid source enough structure to read
 *  well in the editor. Not a full grammar — just keywords, arrows, labels. */
const mermaidLanguage = StreamLanguage.define<unknown>({
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

function highlightStyle(dark: boolean): HighlightStyle {
  const c = dark
    ? {
        keyword: '#c678dd',
        comment: '#7f848e',
        string: '#98c379',
        operator: '#56b6c2',
        atom: '#d19a66',
        number: '#d19a66',
        variable: '#abb2bf',
      }
    : {
        keyword: '#a626a4',
        comment: '#a0a1a7',
        string: '#50a14f',
        operator: '#0184bc',
        atom: '#986801',
        number: '#986801',
        variable: '#383a42',
      }
  return HighlightStyle.define([
    { tag: t.keyword, color: c.keyword, fontWeight: '600' },
    { tag: t.comment, color: c.comment, fontStyle: 'italic' },
    { tag: t.string, color: c.string },
    { tag: t.operator, color: c.operator },
    { tag: [t.atom, t.bool], color: c.atom },
    { tag: t.number, color: c.number },
    { tag: t.variableName, color: c.variable },
  ])
}

/* Inline icons for the custom search panel (CodeMirror DOM is not React, so we
 * hand-build small SVGs rather than use lucide components). */
const ARROW_UP =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5V4M4 7.5 8 3.5l4 4"/></svg>'
const ARROW_DOWN =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5V12M4 8.5l4 4 4-4"/></svg>'
const CLOSE_X =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>'

/**
 * A VSCode-styled search / replace panel. Replaces CodeMirror's default checkbox
 * options with icon toggles (Aa / ab̲ / .*), uses up/down arrows for previous /
 * next, drops the "all" (select-all-matches) button, and capitalizes the
 * Replace / Replace All actions.
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
  // Colors reference the shadcn design tokens (driven from the active diagram
  // theme), so the editor surface matches the rest of the site.
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
      '.cm-gutters': {
        border: 'none',
        background: 'transparent',
        color: 'var(--muted-foreground)',
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--foreground) 6%, transparent)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'color-mix(in srgb, var(--foreground) 6%, transparent)',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        {
          backgroundColor: 'color-mix(in srgb, var(--primary) 30%, transparent)',
        },
      // Search / replace panel (⌘F): custom VSCode-styled panel themed with the
      // app's design tokens instead of CodeMirror's default light chrome.
      '.cm-panels': {
        backgroundColor: 'var(--popover)',
        color: 'var(--popover-foreground)',
      },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
      '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
      '.cm-panel.cm-search': {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 10px',
        fontSize: '12px',
      },
      '.cm-search-row': { display: 'flex', alignItems: 'center', gap: '4px' },
      '.cm-search-row .cm-textfield': { flex: '1 1 auto', minWidth: '0' },
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
          "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
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

export interface EditorProps {
  value: string
  onChange: (value: string) => void
  dark: boolean
}

export default function Editor({ value, onChange, dark }: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const lastValueRef = useRef(value)
  const themeCompartment = useRef(new Compartment())
  const highlightCompartment = useRef(new Compartment())

  onChangeRef.current = onChange

  // Mount once.
  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          search({ top: true, createPanel: createSearchPanel }),
          keymap.of([indentWithTab]),
          mermaidLanguage,
          themeCompartment.current.of(editorTheme(dark)),
          highlightCompartment.current.of(
            syntaxHighlighting(highlightStyle(dark)),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const doc = update.state.doc.toString()
              lastValueRef.current = doc
              onChangeRef.current(doc)
            }
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Mount-only; `value`/`dark` changes handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reconcile external value changes (open file, recover version, start over).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (value === lastValueRef.current) return
    lastValueRef.current = value
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    })
  }, [value])

  // React to light/dark switches without remounting.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: [
        themeCompartment.current.reconfigure(editorTheme(dark)),
        highlightCompartment.current.reconfigure(
          syntaxHighlighting(highlightStyle(dark)),
        ),
      ],
    })
  }, [dark])

  return <div ref={hostRef} className="editor-host" />
}
