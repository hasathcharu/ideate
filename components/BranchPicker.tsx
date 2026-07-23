'use client'

import { useEffect, useMemo, useState } from 'react'
import { GitBranch, Loader2, Lock, Plus } from 'lucide-react'
import { listBranches } from '@/app/actions/github'
import type { Branch } from '@/lib/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'

export interface BranchPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  owner: string
  name: string
  currentBranch: string
  defaultBranch: string
  /** Owned by the parent, like DeleteModal's `busy` — keeps the picker open
   *  (with a spinner on the create row) while a create is in flight. */
  creating: boolean
  onSelect: (branch: string) => void
  onCreate: (branch: string) => void
}

const INVALID_CHARS = ['~', '^', ':', '?', '*', '[', '\\']

/** Loosely enforced git ref-name rules — enough to catch the common mistakes
 *  before GitHub's raw 422 body would otherwise reach the user. */
export function validateBranchName(value: string): string | null {
  if (!value.trim()) return 'Enter a branch name.'
  if (/\s/.test(value)) return 'Branch names can’t contain spaces.'
  if (value.startsWith('-')) return 'Branch names can’t start with “-”.'
  if (value.includes('..')) return 'Branch names can’t contain “..”.'
  if (value.endsWith('.lock')) return 'Branch names can’t end with “.lock”.'
  if (INVALID_CHARS.some((c) => value.includes(c))) {
    return `Branch names can’t contain ${INVALID_CHARS.join(' ')}`
  }
  return null
}

export default function BranchPicker({
  open,
  onOpenChange,
  owner,
  name,
  currentBranch,
  defaultBranch,
  creating,
  onSelect,
  onCreate,
}: BranchPickerProps) {
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setBranches(null)
    setError(null)
    setFilter('')
    listBranches(owner, name).then((res) => {
      if (cancelled) return
      if (res.ok) setBranches(res.data)
      else setError(res.error.message)
    })
    return () => {
      cancelled = true
    }
  }, [open, owner, name])

  const filtered = useMemo(() => {
    if (!branches) return []
    const q = filter.trim().toLowerCase()
    if (!q) return branches
    return branches.filter((b) => b.name.toLowerCase().includes(q))
  }, [branches, filter])

  const trimmed = filter.trim()
  const exactMatch = branches?.some((b) => b.name === trimmed) ?? true
  const canCreate = !!branches && !!trimmed && !exactMatch && !validateBranchName(trimmed)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Switch branches</DialogTitle>
          <DialogDescription>
            Pick a branch to read and commit to, or create a new one from{' '}
            <code>{currentBranch}</code>.
          </DialogDescription>
        </DialogHeader>

        <Input
          placeholder="Find or create a branch…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />

        <ScrollArea className="h-80 min-w-0 -mx-1 px-1">
          {error ? (
            <p className="px-2 py-6 text-center text-sm text-destructive">{error}</p>
          ) : branches === null ? (
            <p className="flex items-center justify-center gap-2 px-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading branches…
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {canCreate ? (
                <li>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                    onClick={() => onCreate(trimmed)}
                    disabled={creating}
                  >
                    {creating ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin" />
                    ) : (
                      <Plus className="size-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      Create branch <strong className="text-foreground">“{trimmed}”</strong> from{' '}
                      <code>{currentBranch}</code>
                    </span>
                  </button>
                </li>
              ) : null}
              {filtered.length === 0 && !canCreate ? (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                  No branches match “{filter}”.
                </p>
              ) : (
                filtered.map((b) => (
                  <li key={b.name}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                      onClick={() => onSelect(b.name)}
                      disabled={b.name === currentBranch}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {b.protected ? <Lock className="size-3 text-muted-foreground" /> : null}
                        {b.name === defaultBranch ? <Badge variant="outline">default</Badge> : null}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
