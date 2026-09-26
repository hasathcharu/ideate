'use client'

import type { KeyboardEvent, PointerEvent, RefObject } from 'react'
import Canvas from './Canvas'
import CanvasSkeleton from './CanvasSkeleton'
import DiffView from './DiffView'
import Editor, { type EditorHandle } from './Editor'
import MarkdownPreview, { type MarkdownPreviewHandle } from './MarkdownPreview'
import Preview from './Preview'
import ImagePreview from './ImagePreview'
import SvgPreview from './SvgPreview'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
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
  onHoverFile: (path: string) => void
  markdownMaximized: boolean
  onMarkdownMaximizedChange: (maximized: boolean) => void
  linkTrail: ReadonlyArray<{ path: string; scrollTop: number }>
  markdownScrollTop: number
  onBack: () => void
  assetKind?: 'raster' | 'svg' | null
  /** The workspace has files, none is open, and there is no scratch work to show —
   *  see `awaitingFileChoice` in AppShell. */
  awaitingFileChoice: boolean
  /** Which document to show is still being resolved — see `surfaceLoading`. */
  loading: boolean
  loadingKind: FileKind
  loadingRasterImage: boolean
}

/** Line widths that read as source rather than prose: a couple of long runs, some
 *  short ones, and an indent step, so the skeleton has the shape of a document. */
const SKELETON_LINES = [
  { width: 'w-2/5', indent: 0 },
  { width: 'w-4/5', indent: 1 },
  { width: 'w-3/5', indent: 1 },
  { width: 'w-2/3', indent: 1 },
  { width: 'w-1/2', indent: 1 },
  { width: 'w-1/4', indent: 0 },
  { width: 'w-3/4', indent: 1 },
  { width: 'w-2/5', indent: 1 },
] as const

/**
 * The right pane's placeholder: an abstract flowchart — a node, a decision, a branch
 * and a join — standing in for the rendered diagram.
 *
 * Drawn as one SVG rather than divs. The edges turn corners, and a corner between
 * two 1px elements is always square no matter what radius they carry; a path with
 * `stroke-linejoin` and quadratic turns is the only way to round them.
 *
 * Deliberately generic. Which document is coming is exactly what has not been
 * resolved yet — that is what the skeleton is waiting on — so this cannot be shaped
 * to the real one; it says "a rendered document lands here" and no more.
 */
function DiagramSkeleton() {
  return (
    <svg
      viewBox="0 0 240 292"
      className="h-auto w-full max-w-80"
      fill="none"
      aria-hidden
    >
      {/* Edges stay still: pulsing them alongside the nodes made the whole shape
          throb as one mass instead of reading as boxes joined by lines. Each branch
          is a single path, so its two turns round off against the straight runs. */}
      <g
        className="stroke-border"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M120 40 V63" />
        {/* One edge out of each side vertex, not one leaving the bottom and forking:
            these two share no segment, so the decision reads as having two outcomes
            rather than one line that splits somewhere below it. */}
        <path d="M98 86 H68 Q60 86 60 94 V156" />
        <path d="M142 86 H172 Q180 86 180 94 V156" />
        <path d="M60 196 V214 Q60 222 68 222 H112 Q120 222 120 230 V252" />
        <path d="M180 196 V214 Q180 222 172 222 H128 Q120 222 120 230 V252" />
      </g>
      <g className="animate-pulse fill-muted">
        <rect x="70" y="0" width="100" height="40" rx="10" />
        {/* The decision node, squared then turned — a diamond is the one shape here
            no corner radius alone can make. Rounded before rotating, so its points
            are soft like every other corner. */}
        <rect x="104" y="70" width="32" height="32" rx="5" transform="rotate(45 120 86)" />
        <rect x="20" y="156" width="80" height="40" rx="10" />
        <rect x="140" y="156" width="80" height="40" rx="10" />
        <rect x="70" y="252" width="100" height="40" rx="10" />
      </g>
    </svg>
  )
}

/** Placeholder for the split view, in its real geometry so nothing jumps when the
 *  document swaps in: editor lines on the left, a diagram shape on the right where
 *  the rendered document lands. */
function SurfaceSkeleton({
  paneRowRef,
  editorRatio,
  kind,
  markdownMaximized,
  rasterImage,
}: Pick<DocumentSurfaceProps, 'paneRowRef' | 'editorRatio' | 'markdownMaximized'> &
  { kind: FileKind; rasterImage: boolean }) {
  if (rasterImage) return (
    <section className="flex min-h-0 flex-1 items-center justify-center bg-background p-8"
      aria-busy aria-label="Loading image">
      <Skeleton className="aspect-[4/3] max-h-[70vh] w-full max-w-xl rounded-xl" />
    </section>
  )
  if (kind === 'markdown' && markdownMaximized) return (
    <section className="fixed inset-0 z-50 overflow-hidden bg-background px-8 pt-24" aria-busy aria-label="Loading document">
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="mt-10 h-6 w-2/5" />
        <Skeleton className="h-4 w-11/12" />
      </div>
    </section>
  )
  if (kind === 'excalidraw') return <CanvasSkeleton />
  return (
    <div
      ref={paneRowRef}
      className="grid min-h-0 flex-1"
      style={{ gridTemplateColumns: `minmax(0,${editorRatio}fr) 6px minmax(0,${1 - editorRatio}fr)` }}
      aria-busy
      aria-label="Loading document"
    >
      <section className="min-h-0 space-y-2.5 overflow-hidden p-4">
        {SKELETON_LINES.map((line, i) => (
          <div key={i} style={{ paddingLeft: `${line.indent * 16}px` }}>
            <Skeleton className={cn('h-3.5', line.width)} />
          </div>
        ))}
      </section>
      <div className="bg-border/40" />
      <section className={cn('min-h-0 overflow-hidden p-8', kind === 'markdown'
        ? 'space-y-4' : 'flex items-center justify-center')}>
        {kind === 'markdown' ? (
          <>
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-5/6" />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="mt-8 h-5 w-2/5" />
            <Skeleton className="h-3.5 w-11/12" />
          </>
        ) : <DiagramSkeleton />}
      </section>
    </div>
  )
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
  onHoverFile,
  markdownMaximized,
  onMarkdownMaximizedChange,
  linkTrail,
  markdownScrollTop,
  onBack,
  assetKind = null,
  awaitingFileChoice,
  loading,
  loadingKind,
  loadingRasterImage,
}: DocumentSurfaceProps) {
  // Ahead of every other branch: until the document is resolved there is no kind to
  // dispatch on, and each guess painted its own screen on the way through.
  if (loading) return <SurfaceSkeleton paneRowRef={paneRowRef} editorRatio={editorRatio}
    kind={loadingKind} markdownMaximized={markdownMaximized} rasterImage={loadingRasterImage} />
  // Before the surface picks an editor: with files in the workspace and none of them
  // open, there is no document here to edit, and the scratch kinds are no longer
  // offered once a workspace has files of its own.
  if (awaitingFileChoice) {
    return (
      <section
        className="flex min-h-0 flex-1 items-center justify-center p-8"
        aria-label="No file open"
      >
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium">No file open</p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            Pick a file from the sidebar to start working, or use the{' '}
            <strong className="font-medium text-foreground">+</strong> above it to make a
            new one.
          </p>
        </div>
      </section>
    )
  }
  if (assetKind === 'raster' && openPath) return <ImagePreview path={openPath} base64={text} />
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
        {assetKind === 'svg' ? (
          <SvgPreview source={renderedText} />
        ) : kind === 'markdown' ? (
          <MarkdownPreview
            ref={markdownPreviewRef}
            onRevealSource={onRevealEditor}
            text={renderedText}
            config={config}
            path={openPath}
            repo={repo}
            onOpenFile={repo ? onOpenLinkedFile : undefined}
            onHoverFile={repo ? onHoverFile : undefined}
            maximized={markdownMaximized}
            onMaximizedChange={onMarkdownMaximizedChange}
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
