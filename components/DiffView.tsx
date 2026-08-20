'use client'

import { useMemo, useState } from 'react'
import { diffFile, splitRows, type DiffHunk, type DiffLine } from '@/lib/diff'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A diff between two revisions of a text document — side by side, or unified,
 * laid out the way GitHub lays one out: `@@` hunk headers, line numbers on both
 * sides, and tinted rows.
 *
 * Both sides arrive as plain strings, so this has nothing to fetch and nothing to
 * know about where they came from. The editor compares the committed file with the
 * working copy; version history compares two commits; neither difference reaches
 * this component.
 */

export type DiffMode = 'split' | 'unified'

export interface DiffViewProps {
  /** The older side. */
  before: string
  /** The newer side. */
  after: string
  /** Shown in place of the diff when the two sides are identical. */
  emptyMessage?: string
  /** Which layout to open with. The toggle stays available either way. */
  defaultMode?: DiffMode
  /** Column captions in split mode — e.g. "Last commit" / "Working copy". */
  beforeLabel?: string
  afterLabel?: string
}

export default function DiffView({
  before,
  after,
  emptyMessage = 'No differences between these two versions.',
  defaultMode = 'split',
  beforeLabel = 'Before',
  afterLabel = 'After',
}: DiffViewProps) {
  const [mode, setMode] = useState<DiffMode>(defaultMode)
  const diff = useMemo(() => diffFile(before, after), [before, after])

  if (diff.unchanged) {
    return <p className="p-6 text-sm text-muted-foreground">{emptyMessage}</p>
  }

  return (
    <div className="p-3">
      <div className="mb-2 flex flex-wrap items-center gap-3 px-1 text-xs">
        <span className="text-diff-add">+{diff.additions} additions</span>
        <span className="text-diff-remove">−{diff.deletions} deletions</span>
        <div className="ml-auto flex items-center gap-0.5 rounded-md border p-0.5">
          <Button
            size="sm"
            variant={mode === 'split' ? 'secondary' : 'ghost'}
            className="h-6 px-2 text-xs"
            onClick={() => setMode('split')}
          >
            Side by side
          </Button>
          <Button
            size="sm"
            variant={mode === 'unified' ? 'secondary' : 'ghost'}
            className="h-6 px-2 text-xs"
            onClick={() => setMode('unified')}
          >
            Unified
          </Button>
        </div>
      </div>
      {diff.truncated ? (
        <p className="mb-2 rounded-md bg-muted p-2 text-xs text-muted-foreground">
          The two versions differ too much to match line by line — showing the whole document
          as replaced.
        </p>
      ) : null}
      <div className="overflow-hidden rounded-md border font-mono text-xs">
        {mode === 'split' ? (
          <SplitDiff hunks={diff.hunks} beforeLabel={beforeLabel} afterLabel={afterLabel} />
        ) : (
          diff.hunks.map((hunk, i) => <UnifiedHunk key={i} hunk={hunk} first={i === 0} />)
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Unified                                                             */
/* ------------------------------------------------------------------ */

function hunkHeader(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
}

function UnifiedHunk({ hunk, first }: { hunk: DiffHunk; first: boolean }) {
  return (
    <div className={cn(!first && 'border-t')}>
      <div className="bg-muted px-3 py-1 text-[11px] text-muted-foreground">
        {hunkHeader(hunk)}
      </div>
      {hunk.lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            'flex items-start whitespace-pre-wrap',
            line.type === 'add' && 'bg-diff-add/12',
            line.type === 'remove' && 'bg-diff-remove/12',
          )}
        >
          <LineNumber value={line.oldNumber} />
          <LineNumber value={line.newNumber} />
          <span
            className={cn(
              'w-4 flex-none select-none',
              line.type === 'add' && 'text-diff-add',
              line.type === 'remove' && 'text-diff-remove',
            )}
          >
            {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}
          </span>
          {/* `break-all` rather than a horizontal scroll: a wrapped long line keeps
              its line numbers aligned with every other row. */}
          <span className="min-w-0 flex-1 pr-3 break-all">{line.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}

function LineNumber({ value }: { value: number | null }) {
  return (
    <span className="w-10 flex-none px-1 text-right tabular-nums text-muted-foreground/70 select-none">
      {value ?? ''}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Side by side                                                        */
/* ------------------------------------------------------------------ */

/**
 * A four-column grid — number, content, number, content — so the two sides stay
 * aligned even when a long line wraps. A table would do the same job but not
 * survive `break-all` on one side without the rows drifting.
 */
function SplitDiff({
  hunks,
  beforeLabel,
  afterLabel,
}: {
  hunks: DiffHunk[]
  beforeLabel: string
  afterLabel: string
}) {
  return (
    <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem_minmax(0,1fr)]">
      <div className="col-span-2 border-b border-r bg-muted px-2 py-1 text-[11px] text-muted-foreground">
        {beforeLabel}
      </div>
      <div className="col-span-2 border-b bg-muted px-2 py-1 text-[11px] text-muted-foreground">
        {afterLabel}
      </div>
      {hunks.map((hunk, h) => (
        <div key={h} className="col-span-4 grid grid-cols-subgrid">
          <div
            className={cn(
              'col-span-4 bg-muted px-3 py-1 text-[11px] text-muted-foreground',
              h > 0 && 'border-t',
            )}
          >
            {hunkHeader(hunk)}
          </div>
          {splitRows(hunk.lines).map((row, i) => (
            <div key={i} className="col-span-4 grid grid-cols-subgrid">
              <SplitCell line={row.left} side="left" />
              <SplitCell line={row.right} side="right" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function SplitCell({ line, side }: { line: DiffLine | null; side: 'left' | 'right' }) {
  const changed = line !== null && line.type !== 'context'
  const tint = changed
    ? side === 'left'
      ? 'bg-diff-remove/12'
      : 'bg-diff-add/12'
    : line === null
      ? // An empty half: shaded, so it reads as "nothing here" rather than as a
        // blank line that exists in the file.
        'bg-muted/50'
      : undefined
  return (
    <>
      <span
        className={cn(
          'px-1 text-right tabular-nums text-muted-foreground/70 select-none',
          side === 'right' && 'border-l',
          tint,
        )}
      >
        {(side === 'left' ? line?.oldNumber : line?.newNumber) ?? ''}
      </span>
      <span className={cn('pr-2 break-all whitespace-pre-wrap', tint)}>
        {line ? line.text || ' ' : ''}
      </span>
    </>
  )
}
