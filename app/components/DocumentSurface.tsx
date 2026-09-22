'use client'

import type { KeyboardEvent, PointerEvent, RefObject } from 'react'
import Canvas from './Canvas'
import DiffView from './DiffView'
import Editor, { type EditorHandle } from './Editor'
import MarkdownPreview, { type MarkdownPreviewHandle } from './MarkdownPreview'
import Preview from './Preview'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import type { FileKind } from '@/lib/tree'
import type { RepoRef } from '@/lib/types'

export interface DocumentSurfaceProps {
  kind: FileKind
  openPath: string | null
  documentId: string
  text: string
  onChange: (value: string) => void
  canvasTheme: 'light' | 'dark'
  canvasBackground: string | undefined
  showDiff: boolean
  canDiff: boolean
  baseline: string
  renderedText: string
  paneRowRef: RefObject<HTMLDivElement | null>
  editorRatio: number
  onDividerPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onDividerKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  editorRef: RefObject<EditorHandle | null>
  markdownPreviewRef: RefObject<MarkdownPreviewHandle | null>
  editorDark: boolean
  wrapLines: boolean
  loaded: boolean
  filePaths: readonly string[]
  minimap: boolean
  onRevealPreview: (line: number) => void
  onRevealEditor: (line: number) => void
  config: MermaidUserConfig | null
  repo: RepoRef | null
  onOpenLinkedFile: (path: string, scrollTop: number) => void
  linkTrail: ReadonlyArray<{ path: string; scrollTop: number }>
  markdownScrollTop: number
  onBack: () => void
}

/** Active editor/preview surface. Document state and commands remain owned by AppShell. */
export default function DocumentSurface({
  kind,
  openPath,
  documentId,
  text,
  onChange,
  canvasTheme,
  canvasBackground,
  showDiff,
  canDiff,
  baseline,
  renderedText,
  paneRowRef,
  editorRatio,
  onDividerPointerDown,
  onDividerKeyDown,
  editorRef,
  markdownPreviewRef,
  editorDark,
  wrapLines,
  loaded,
  filePaths,
  minimap,
  onRevealPreview,
  onRevealEditor,
  config,
  repo,
  onOpenLinkedFile,
  linkTrail,
  markdownScrollTop,
  onBack,
}: DocumentSurfaceProps) {
  if (kind === 'excalidraw') {
    return (
      <section className="min-h-0 flex-1" aria-label="Canvas">
        <Canvas
          key={documentId}
          value={text}
          onChange={onChange}
          theme={canvasTheme}
          backgroundColor={canvasBackground}
        />
      </section>
    )
  }

  if (showDiff && canDiff) {
    return (
      <section className="min-h-0 flex-1 overflow-auto" aria-label="Uncommitted changes">
        <DiffView
          before={baseline}
          after={renderedText}
          beforeLabel="Last commit"
          afterLabel="Working copy"
          emptyMessage="No uncommitted changes — this document matches the last commit."
        />
      </section>
    )
  }

  return (
    <div
      ref={paneRowRef}
      className="grid min-h-0 flex-1"
      style={{ gridTemplateColumns: `minmax(0,${editorRatio}fr) 6px minmax(0,${1 - editorRatio}fr)` }}
    >
      <section className="min-h-0 overflow-auto" aria-label="Editor">
        <Editor
          ref={editorRef}
          documentId={documentId}
          value={text}
          onChange={onChange}
          dark={editorDark}
          kind={kind}
          wrap={wrapLines}
          baseline={loaded ? baseline : null}
          filePaths={filePaths}
          docPath={openPath}
          minimap={minimap}
          onRevealPreview={kind === 'markdown' ? onRevealPreview : undefined}
        />
      </section>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize editor and preview"
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(editorRatio * 100)}
        tabIndex={0}
        onPointerDown={onDividerPointerDown}
        onKeyDown={onDividerKeyDown}
        className="group flex cursor-col-resize touch-none items-center justify-center bg-border transition-colors hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none"
      >
        <div className="h-8 w-0.5 rounded-full bg-muted-foreground/40 transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
      </div>
      <section className="min-h-0 overflow-auto" aria-label="Preview">
        {kind === 'markdown' ? (
          <MarkdownPreview
            ref={markdownPreviewRef}
            onRevealSource={onRevealEditor}
            text={renderedText}
            config={config}
            path={openPath}
            repo={repo}
            onOpenFile={repo ? onOpenLinkedFile : undefined}
            navigationScrollTop={markdownScrollTop}
            onBack={linkTrail.length > 0 ? onBack : undefined}
            backLabel={linkTrail[linkTrail.length - 1]?.path}
          />
        ) : (
          <Preview text={renderedText} config={config} />
        )}
      </section>
    </div>
  )
}
