'use client'

import { useCallback, useRef } from 'react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CONFIG_PLACEHOLDER } from '@/lib/mermaidConfig'

export interface ConfigModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Raw YAML config text. */
  value: string
  /** Called on every edit with the new raw text. */
  onChange: (value: string) => void
  /** Parse error for the current text, or null when it's valid/empty. */
  error: string | null
}

/** A small YAML stream tokenizer — just enough structure to read config well.
 *  Mirrors the mermaid tokenizer in Editor.tsx (keys, strings, scalars). */
const yamlLanguage = StreamLanguage.define<unknown>({
  token(stream) {
    if (stream.eatSpace()) return null
    if (stream.match(/#.*/)) return 'comment'
    if (stream.sol() && stream.match(/(---|\.\.\.)\s*$/)) return 'meta'
    if (stream.match(/-?\d+(?:\.\d+)?\b/)) return 'number'
    if (stream.match(/"(?:[^"\\]|\\.)*"/) || stream.match(/'(?:[^']|'')*'/)) return 'string'
    if (stream.match(/\b(?:true|false|null|yes|no|on|off)\b/i)) return 'atom'
    // A mapping key: an identifier immediately followed by a colon.
    if (stream.match(/[\w.-]+(?=\s*:(?:\s|$))/)) return 'keyword'
    stream.next()
    return null
  },
})

function highlightStyle(): HighlightStyle {
  const accent = 'var(--primary)'
  const blend = (pct: number) => `color-mix(in oklab, var(--primary) ${pct}%, var(--foreground))`
  return HighlightStyle.define([
    { tag: t.keyword, color: accent, fontWeight: '600' },
    { tag: t.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
    { tag: t.string, color: blend(55) },
    { tag: [t.atom, t.bool], color: blend(40) },
    { tag: t.number, color: blend(40) },
    { tag: t.meta, color: 'var(--muted-foreground)' },
  ])
}

function editorTheme() {
  return EditorView.theme({
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
    '.cm-content': { padding: '10px 0', caretColor: 'var(--primary)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--primary)' },
    '.cm-gutters': {
      border: 'none',
      backgroundColor: 'transparent',
      color: 'var(--muted-foreground)',
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--foreground) 5%, transparent)',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--primary) 30%, transparent)',
    },
    '.cm-placeholder': { color: 'var(--muted-foreground)', fontStyle: 'italic' },
  })
}

export default function ConfigModal({
  open,
  onOpenChange,
  value,
  onChange,
  error,
}: ConfigModalProps) {
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const valueRef = useRef(value)
  onChangeRef.current = onChange
  valueRef.current = value

  // A callback ref mounts CodeMirror the instant the host node attaches and
  // tears it down when it detaches. This is immune to the portal + open/close
  // animation timing of the Radix dialog (a plain mount effect can run before
  // the portaled node exists, leaving an empty box). The dialog only renders
  // its content while open, so the node attaches with the current value and
  // detaches on close.
  const hostRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      viewRef.current?.destroy()
      viewRef.current = null
      return
    }
    const view = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          basicSetup,
          yamlLanguage,
          editorTheme(),
          syntaxHighlighting(highlightStyle()),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'Mermaid configuration (YAML)' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    view.focus()
  }, [])

  // Reconcile external value changes (e.g. "Load example" / "Clear" buttons).
  const replaceDoc = (next: string) => {
    const view = viewRef.current
    if (!view) {
      onChangeRef.current(next)
      return
    }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    view.focus()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Diagram configuration</DialogTitle>
          <DialogDescription>
            The global mermaid config in YAML — the single source of truth, applied to every
            diagram.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-card">
          <div ref={hostRef} className="h-[46vh] overflow-auto" />
        </div>

        {value.trim() ? (
          error ? (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 flex-none" />
              <span className="min-w-0 break-words">{error}</span>
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="size-4 flex-none text-primary" />
              Valid — applied live.
            </p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            Empty — mermaid defaults are used.
          </p>
        )}

        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => replaceDoc(CONFIG_PLACEHOLDER)}>
              Load example
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => replaceDoc('')}
              disabled={!value.trim()}
            >
              Clear
            </Button>
          </div>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
