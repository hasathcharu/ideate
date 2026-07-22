'use client'

import { useEffect, useRef } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
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
