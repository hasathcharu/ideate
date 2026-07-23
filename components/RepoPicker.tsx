'use client'

import { useEffect, useMemo, useState } from 'react'
import { Lock, Loader2 } from 'lucide-react'
import { listRepos } from '@/app/actions/github'
import { APP_NAME } from '@/lib/config'
import type { Repo } from '@/lib/types'
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

export interface RepoPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (repo: Repo) => void
}

export default function RepoPicker({ open, onOpenChange, onSelect }: RepoPickerProps) {
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setRepos(null)
    setError(null)
    listRepos().then((res) => {
      if (cancelled) return
      if (res.ok) setRepos(res.data)
      else setError(res.error.message)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const filtered = useMemo(() => {
    if (!repos) return []
    const q = filter.trim().toLowerCase()
    if (!q) return repos
    return repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
  }, [repos, filter])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Connect a repository</DialogTitle>
          <DialogDescription>
            Pick the repo to use as your database. {APP_NAME} reads and writes the{' '}
            <code>main</code> branch only.
          </DialogDescription>
        </DialogHeader>

        <Input
          placeholder="Filter repositories…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />

        <ScrollArea className="h-80 min-w-0 -mx-1 px-1">
          {error ? (
            <p className="px-2 py-6 text-center text-sm text-destructive">{error}</p>
          ) : repos === null ? (
            <p className="flex items-center justify-center gap-2 px-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading your repositories…
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              No repositories match “{filter}”.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filtered.map((repo) => (
                <li key={`${repo.owner}/${repo.name}`}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent"
                    onClick={() => onSelect(repo)}
                  >
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {repo.owner}/<span className="text-foreground">{repo.name}</span>
                    </span>
                    <Badge variant="outline" className="shrink-0 gap-1">
                      {repo.private ? <Lock className="size-3" /> : null}
                      {repo.private ? 'Private' : 'Public'}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
