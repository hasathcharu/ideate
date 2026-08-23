'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Lock, PackagePlus, RefreshCw, Settings2 } from 'lucide-react'
import { listRepos } from '@/app/actions/github'
import { handleExpiredSession } from '@/lib/sessionExpiry'
import { GITHUB_APP_INSTALL_URL } from '@/lib/config'
import { cn } from '@/lib/utils'
import type { ActionError, Repo } from '@/lib/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

/** Varied name widths, since `owner/name` lengths differ a lot in practice. */
const REPO_SKELETON_WIDTHS = ['w-52', 'w-36', 'w-60', 'w-44', 'w-56', 'w-40'] as const

/** Placeholder repo rows, matching the real row's `px-2.5 py-2` and its
 *  name-plus-visibility-badge layout so the list doesn't shift when it loads. */
function RepoListSkeleton() {
  return (
    <ul className="flex flex-col gap-0.5" aria-hidden>
      {REPO_SKELETON_WIDTHS.map((width, i) => (
        <li key={i} className="flex items-center justify-between gap-2 px-2.5 py-2">
          <Skeleton className={cn('h-4', width)} />
          <Skeleton className="h-5 w-16 shrink-0" />
        </li>
      ))}
    </ul>
  )
}

export interface RepoPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (repo: Repo) => void
}

export default function RepoPicker({ open, onOpenChange, onSelect }: RepoPickerProps) {
  const [repos, setRepos] = useState<Repo[] | null>(null)
  /** 0 = the GitHub App is authorized but installed nowhere → onboarding state. */
  const [installationCount, setInstallationCount] = useState<number | null>(null)
  const [error, setError] = useState<ActionError | null>(null)
  const [filter, setFilter] = useState('')
  /** A fetch is in flight — disables the refresh control. */
  const [pending, setPending] = useState(false)
  /** That fetch is a user-triggered refresh (spins the icon; keeps the list up). */
  const [refreshing, setRefreshing] = useState(false)

  /** Bumped per request so a superseded or closed-dialog response is ignored. */
  const requestId = useRef(0)

  const load = useCallback(async (mode: 'initial' | 'refresh') => {
    const id = ++requestId.current
    if (mode === 'initial') {
      setRepos(null)
      setInstallationCount(null)
    }
    setError(null)
    setPending(true)
    setRefreshing(mode === 'refresh')
    const res = await listRepos()
    if (id !== requestId.current) return
    setPending(false)
    setRefreshing(false)
    if (res.ok) {
      setRepos(res.data.repos)
      setInstallationCount(res.data.installationCount)
    } else if (!handleExpiredSession(res.error)) {
      setError(res.error)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load('initial')
    // Invalidate anything in flight so a late response can't land on a reopened
    // dialog (or after unmount).
    return () => {
      requestId.current += 1
    }
  }, [open, load])

  const filtered = useMemo(() => {
    if (!repos) return []
    const q = filter.trim().toLowerCase()
    if (!q) return repos
    return repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
  }, [repos, filter])

  // The App can be authorized without being installed on a single repo, which
  // would otherwise render as an inexplicably empty list.
  const notInstalled = installationCount === 0

  /** Re-runs `listRepos()`. Installing / sharing a repo happens on GitHub in another
   *  tab, so there is no event to react to — the user has to be able to ask. */
  const refresh = () => void load('refresh')

  const refreshLabel = (
    <>
      <RefreshCw className={cn(refreshing && 'animate-spin')} /> Refresh
    </>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Connect a repository</DialogTitle>
          <DialogDescription>
            Pick the repo to use as your database. Only repositories you granted this
            app access to are listed. You can switch branches (or create one) after
            connecting.
          </DialogDescription>
        </DialogHeader>

        {notInstalled ? null : (
          <Input
            placeholder="Filter repositories…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
        )}

        <ScrollArea className="h-80 min-w-0 -mx-1 px-1">
          {error ? (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <p className="text-sm text-destructive">{error.message}</p>
              {/* No `unauthenticated` branch: a dead session never reaches here —
                  `handleExpiredSession` signs out and leaves for the landing page,
                  which is where signing in again lives. */}
              <Button size="sm" variant="outline" onClick={refresh} disabled={pending}>
                {refreshLabel}
              </Button>
            </div>
          ) : repos === null ? (
            <RepoListSkeleton />
          ) : notInstalled ? (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <PackagePlus className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium">No repositories shared yet</p>
              <p className="text-sm text-muted-foreground">
                You’re signed in, but the app hasn’t been installed on any repository.
                Install it and choose either all your repositories or just the ones you
                want to keep diagrams in.
              </p>
              <div className="flex items-center justify-center gap-2">
                <Button asChild size="sm">
                  <a href={GITHUB_APP_INSTALL_URL} target="_blank" rel="noreferrer noopener">
                    <PackagePlus /> Install on GitHub
                  </a>
                </Button>
                <Button size="sm" variant="outline" onClick={refresh} disabled={pending}>
                  {refreshLabel}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Installing happens in a new tab — come back and hit Refresh.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {filter
                ? `No repositories match “${filter}”.`
                : 'The app is installed, but no repositories are shared with it yet.'}
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

        {/* Persistent escape hatches: repository access is editable after install, and
            "the repo I want isn't listed" is the most likely reason someone reopens
            this dialog — which is also why Refresh lives here, since granting access
            happens on GitHub with nothing to notify us. Hidden where a more specific
            call to action is already on screen (the install prompt / an error). */}
        {notInstalled || error ? null : (
          <div className="flex items-center justify-center gap-1 border-t pt-3">
            <Button variant="ghost" size="sm" onClick={refresh} disabled={pending}>
              {refreshLabel}
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href={GITHUB_APP_INSTALL_URL} target="_blank" rel="noreferrer noopener">
                <Settings2 /> Configure repository access
              </a>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
