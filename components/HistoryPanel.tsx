'use client'

import { ArrowLeft } from 'lucide-react'
import type { FileCommit } from '@/lib/types'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import Preview from './Preview'
import Canvas from './Canvas'
import type { FileKind } from '@/lib/tree'
import { cn } from '@/lib/utils'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export interface HistoryPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The file's current/canonical path. */
  path: string
  /** The path segment the commit list below is currently showing — differs from
   *  `path` once the user has stepped into history from before a rename. */
  historyPath: string
  commits: FileCommit[] | null
  error: string | null
  /** More commits exist at `historyPath` beyond the current page. */
  hasMore: boolean
  loadingMore: boolean
  /** Set once the earliest loaded commit at `historyPath` renamed the file in
   *  from this older path — offer it as a "view history before rename" step. */
  renamedFrom: string | null
  /** True once the user has stepped into an older path's history, so a "back to
   *  newer history" action makes sense. */
  canGoBack: boolean
  selectedSha: string | null
  versionContent: string | null
  versionLoading: boolean
  config: MermaidUserConfig | null
  /** Which renderer previews a selected version — scenes get a read-only canvas
   *  rather than the mermaid preview. */
  kind: FileKind
  /** Light/dark mode for the read-only canvas, derived from the active theme. */
  canvasTheme: 'light' | 'dark'
  /** The active theme's background color, painted behind the read-only canvas. */
  canvasBackground: string | undefined
  onSelect: (commit: FileCommit) => void
  onLoadMore: () => void
  onViewBeforeRename: () => void
  onBack: () => void
  onRecover: () => void
  onFork: () => void
}

/** The read-only canvas can't emit edits (`viewMode`), so its onChange is inert. */
function noop(): void {}

/** Varied label widths so a loading commit list reads as a list of distinct
 *  entries rather than a stack of identical bars. */
const COMMIT_SKELETON_WIDTHS = ['w-40', 'w-28', 'w-44', 'w-32', 'w-36'] as const

/**
 * Placeholder commit rows. Returns a fragment rather than a wrapper so each row is
 * a direct child of the list's flex container and picks up its `gap-1`; geometry
 * matches the real commit button (`p-2.5`, message line over a meta line) so the
 * list doesn't jump when the data lands.
 */
function CommitSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {COMMIT_SKELETON_WIDTHS.slice(0, rows).map((width, i) => (
        <div key={i} className="border border-transparent p-2.5" aria-hidden>
          <Skeleton className={cn('mb-1.5 h-3.5', width)} />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </>
  )
}

function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function HistoryPanel({
  open,
  onOpenChange,
  path,
  historyPath,
  commits,
  error,
  hasMore,
  loadingMore,
  renamedFrom,
  canGoBack,
  selectedSha,
  versionContent,
  versionLoading,
  config,
  kind,
  canvasTheme,
  canvasBackground,
  onSelect,
  onLoadMore,
  onViewBeforeRename,
  onBack,
  onRecover,
  onFork,
}: HistoryPanelProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 data-[side=right]:sm:max-w-4xl"
      >
        <SheetHeader className="border-b">
          <SheetTitle>Version history</SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">
            {path}
            {historyPath !== path ? (
              <span className="mt-0.5 block text-muted-foreground/80">
                Showing history for <code className="break-all">{historyPath}</code> from before
                the rename
              </span>
            ) : null}
          </SheetDescription>
        </SheetHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
          <div className="flex flex-col gap-1 overflow-auto border-r p-2.5">
            {canGoBack ? (
              <Button
                variant="ghost"
                size="sm"
                className="mb-1 justify-start"
                onClick={onBack}
              >
                <ArrowLeft /> Back to newer history
              </Button>
            ) : null}

            {error ? (
              <p className="p-4 text-sm text-destructive">{error}</p>
            ) : commits === null ? (
              <CommitSkeleton rows={COMMIT_SKELETON_WIDTHS.length} />
            ) : commits.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No commits for this file.</p>
            ) : (
              <>
                {commits.map((c) => (
                  <button
                    key={c.sha}
                    type="button"
                    onClick={() => onSelect(c)}
                    className={cn(
                      'rounded-md border border-transparent p-2.5 text-left hover:bg-accent',
                      selectedSha === c.sha && 'border-primary bg-primary/10',
                    )}
                  >
                    <div className="mb-0.5 truncate text-sm">{c.message}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.author} · {formatDate(c.date)} · {c.sha.slice(0, 7)}
                    </div>
                  </button>
                ))}

                {loadingMore ? (
                  <CommitSkeleton rows={2} />
                ) : hasMore ? (
                  <Button variant="ghost" size="sm" onClick={onLoadMore}>
                    Load more
                  </Button>
                ) : renamedFrom ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto justify-start py-1.5 text-left whitespace-normal"
                    onClick={onViewBeforeRename}
                  >
                    <span>
                      View history before rename from{' '}
                      <code className="font-mono break-all">{renamedFrom}</code>
                    </span>
                  </Button>
                ) : null}
              </>
            )}
          </div>

          <div className="flex min-h-0 flex-col">
            {selectedSha === null ? (
              <p className="p-6 text-sm text-muted-foreground">
                Select a version to preview it read-only.
              </p>
            ) : versionLoading || versionContent === null ? (
              <div className="min-h-0 flex-1 p-6" aria-hidden>
                <Skeleton className="size-full" />
              </div>
            ) : (
              <>
                <div className="min-h-0 flex-1">
                  {kind === 'excalidraw' ? (
                    // Keyed on the sha so selecting another version remounts the
                    // canvas rather than diffing one historical scene into another.
                    <Canvas
                      key={selectedSha}
                      value={versionContent}
                      onChange={noop}
                      theme={canvasTheme}
                      backgroundColor={canvasBackground}
                      viewMode
                    />
                  ) : (
                    <Preview text={versionContent} config={config} />
                  )}
                </div>
                <div className="flex justify-end gap-2 border-t p-3">
                  <Button variant="secondary" onClick={onFork}>
                    {kind === 'excalidraw' ? 'Create new canvas from this' : 'Create new diagram from this'}
                  </Button>
                  <Button onClick={onRecover}>Recover to working tree</Button>
                </div>
              </>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
