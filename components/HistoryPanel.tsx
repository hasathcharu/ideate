'use client'

import { Loader2 } from 'lucide-react'
import type { FileCommit } from '@/lib/types'
import Preview from './Preview'
import { cn } from '@/lib/utils'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'

export interface HistoryPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  path: string
  commits: FileCommit[] | null
  error: string | null
  selectedSha: string | null
  versionContent: string | null
  versionLoading: boolean
  onSelect: (commit: FileCommit) => void
  onRecover: () => void
  onFork: () => void
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
  commits,
  error,
  selectedSha,
  versionContent,
  versionLoading,
  onSelect,
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
          <SheetDescription className="font-mono text-xs">{path}</SheetDescription>
        </SheetHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
          <div className="flex flex-col gap-1 overflow-auto border-r p-2.5">
            {error ? (
              <p className="p-4 text-sm text-destructive">{error}</p>
            ) : commits === null ? (
              <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading commits…
              </p>
            ) : commits.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No commits for this file.</p>
            ) : (
              commits.map((c) => (
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
                  {c.path !== path ? (
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">
                      ↳ was <code>{c.path}</code>
                    </div>
                  ) : null}
                </button>
              ))
            )}
          </div>

          <div className="flex min-h-0 flex-col">
            {selectedSha === null ? (
              <p className="p-6 text-sm text-muted-foreground">
                Select a version to preview it read-only.
              </p>
            ) : versionLoading || versionContent === null ? (
              <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading version…
              </p>
            ) : (
              <>
                <div className="min-h-0 flex-1">
                  <Preview text={versionContent} />
                </div>
                <div className="flex justify-end gap-2 border-t p-3">
                  <Button variant="secondary" onClick={onFork}>
                    Create new diagram from this
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
