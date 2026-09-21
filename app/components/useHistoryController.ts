'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listFileCommits, readFileAtRef } from '@/app/actions/github'
import { handleExpiredSession } from '@/lib/sessionExpiry'
import { RequestGate } from '@/lib/workspaceStore'
import type { FileCommit, RepoRef } from '@/lib/types'
import type { HistoryCompare, HistoryDiff, HistoryView } from './HistoryPanel'

const HISTORY_PAGE_SIZE = 30

export interface HistoryControllerOptions {
  repo: RepoRef | null
  openPath: string | null
  workspaceIdentity: string
  workingContent: string
  onRecover: (content: string) => void
  onFork: (content: string) => void
}

export interface HistoryController {
  open: boolean
  onOpenChange: (open: boolean) => void
  openHistory: () => Promise<void>
  reset: () => void
  historyPath: string | null
  commits: FileCommit[] | null
  error: string | null
  hasMore: boolean
  loadingMore: boolean
  renamedFrom: string | null
  canGoBack: boolean
  selectedSha: string | null
  versionContent: string | null
  versionLoading: boolean
  view: HistoryView
  onViewChange: (view: HistoryView) => void
  compare: HistoryCompare
  onCompareChange: (compare: HistoryCompare) => void
  diff: HistoryDiff | null
  diffLoading: boolean
  diffNote: string | null
  onSelect: (commit: FileCommit) => void
  onLoadMore: () => void
  onViewBeforeRename: () => void
  onBack: () => void
  onRecover: () => void
  onFork: () => void
}

/**
 * Owns history requests and their settled document identity. AppShell supplies
 * only the current identity/content and the working-copy commands used by the
 * Recover and Fork actions.
 */
export function useHistoryController({
  repo,
  openPath,
  workspaceIdentity,
  workingContent,
  onRecover,
  onFork,
}: HistoryControllerOptions): HistoryController {
  const [open, setOpen] = useState(false)
  const versionRequests = useRef(new RequestGate())
  const historyRequests = useRef(new RequestGate())
  const historyTarget = useRef<string | null>(null)
  const workspaceRef = useRef(workspaceIdentity)
  workspaceRef.current = workspaceIdentity

  const [historyPath, setHistoryPath] = useState<string | null>(null)
  const [historyPathStack, setHistoryPathStack] = useState<string[]>([])
  const [commits, setCommits] = useState<FileCommit[] | null>(null)
  const [historyPage, setHistoryPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [renamedFrom, setRenamedFrom] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [versionContent, setVersionContent] = useState<string | null>(null)
  const [versionLoading, setVersionLoading] = useState(false)
  const [view, setView] = useState<HistoryView>('preview')
  const [compare, setCompare] = useState<HistoryCompare>('previous')
  const [previousContent, setPreviousContent] = useState<string | null>(null)
  const [previousLoading, setPreviousLoading] = useState(false)
  const [diffNote, setDiffNote] = useState<string | null>(null)

  const reset = useCallback(() => {
    historyRequests.current.invalidate()
    versionRequests.current.invalidate()
    historyTarget.current = null
    setOpen(false)
    setHistoryPath(null)
    setHistoryPathStack([])
    setCommits(null)
    setVersionContent(null)
    setError(null)
    setVersionLoading(false)
    setLoadingMore(false)
    setPreviousLoading(false)
  }, [])

  const selectVersion = useCallback(async (commit: FileCommit) => {
    if (!repo) return
    const requestedWorkspace = workspaceRef.current
    const requestedPath = historyTarget.current
    const requestKey = JSON.stringify([requestedWorkspace, requestedPath])
    const request = versionRequests.current.begin(requestKey)
    setSelectedSha(commit.sha)
    setVersionLoading(true)
    setVersionContent(null)
    setPreviousContent(null)
    setDiffNote(null)
    const res = await readFileAtRef(repo.owner, repo.name, commit.path, commit.sha)
    const currentKey = JSON.stringify([workspaceRef.current, historyTarget.current])
    if (!versionRequests.current.accepts(request, currentKey)) return
    setVersionLoading(false)
    if (res.ok) setVersionContent(res.data)
    else if (!handleExpiredSession(res.error)) setError(res.error.message)
  }, [repo])

  const loadHistoryPage = useCallback(async (path: string, page: number, append: boolean) => {
    if (!repo) return
    const requestedWorkspace = workspaceRef.current
    historyTarget.current = path
    const requestKey = JSON.stringify([requestedWorkspace, path])
    const request = historyRequests.current.begin(requestKey)
    if (!append) versionRequests.current.invalidate()
    const res = await listFileCommits(
      repo.owner,
      repo.name,
      path,
      repo.branch,
      page,
      HISTORY_PAGE_SIZE,
    )
    const currentKey = JSON.stringify([workspaceRef.current, historyTarget.current])
    if (!historyRequests.current.accepts(request, currentKey)) return
    if (!res.ok) {
      if (!handleExpiredSession(res.error)) setError(res.error.message)
      return
    }
    setCommits((prev) => (append && prev ? [...prev, ...res.data.commits] : res.data.commits))
    setHistoryPage(page)
    setHasMore(res.data.hasMore)
    setRenamedFrom(res.data.renamedFrom)
    if (!append && res.data.commits[0]) void selectVersion(res.data.commits[0])
  }, [repo, selectVersion])

  const openHistory = useCallback(async () => {
    if (!repo || !openPath) return
    setOpen(true)
    setHistoryPath(openPath)
    setHistoryPathStack([])
    setCommits(null)
    setError(null)
    setSelectedSha(null)
    setVersionContent(null)
    setHasMore(false)
    setRenamedFrom(null)
    await loadHistoryPage(openPath, 1, false)
  }, [repo, openPath, loadHistoryPage])

  const loadMore = useCallback(async () => {
    if (!historyPath || loadingMore) return
    setLoadingMore(true)
    await loadHistoryPage(historyPath, historyPage + 1, true)
    setLoadingMore(false)
  }, [historyPath, historyPage, loadingMore, loadHistoryPage])

  const viewBeforeRename = useCallback(async () => {
    if (!historyPath || !renamedFrom) return
    setHistoryPathStack((prev) => [...prev, historyPath])
    setHistoryPath(renamedFrom)
    setCommits(null)
    setHasMore(false)
    setRenamedFrom(null)
    setError(null)
    await loadHistoryPage(renamedFrom, 1, false)
  }, [historyPath, renamedFrom, loadHistoryPage])

  const goBack = useCallback(async () => {
    if (historyPathStack.length === 0) return
    const next = historyPathStack.slice(0, -1)
    const target = historyPathStack[historyPathStack.length - 1]!
    setHistoryPathStack(next)
    setHistoryPath(target)
    setCommits(null)
    setHasMore(false)
    setRenamedFrom(null)
    setError(null)
    await loadHistoryPage(target, 1, false)
  }, [historyPathStack, loadHistoryPage])

  const olderCommit = useMemo(() => {
    if (!commits || !selectedSha) return null
    const index = commits.findIndex((commit) => commit.sha === selectedSha)
    return index >= 0 ? (commits[index + 1] ?? null) : null
  }, [commits, selectedSha])

  const selectedIsOldestLoaded = useMemo(() => {
    if (!commits || !selectedSha) return false
    const index = commits.findIndex((commit) => commit.sha === selectedSha)
    return index >= 0 && index === commits.length - 1
  }, [commits, selectedSha])

  useEffect(() => {
    if (!open || view !== 'diff' || compare !== 'previous') return
    if (!repo || !selectedSha) return
    if (!olderCommit) {
      if (selectedIsOldestLoaded && (hasMore || renamedFrom)) {
        setPreviousContent(null)
        setDiffNote('Load more history to compare this version with the one before it.')
      } else {
        setPreviousContent('')
        setDiffNote(null)
      }
      return
    }
    let cancelled = false
    setDiffNote(null)
    setPreviousLoading(true)
    void readFileAtRef(repo.owner, repo.name, olderCommit.path, olderCommit.sha).then((res) => {
      if (cancelled) return
      setPreviousLoading(false)
      if (res.ok) setPreviousContent(res.data)
      else if (!handleExpiredSession(res.error)) setDiffNote(res.error.message)
    })
    return () => {
      cancelled = true
    }
  }, [
    open,
    view,
    compare,
    repo,
    selectedSha,
    olderCommit,
    selectedIsOldestLoaded,
    hasMore,
    renamedFrom,
  ])

  const diff = useMemo(() => {
    if (view !== 'diff' || versionContent === null) return null
    if (compare === 'working') return { before: versionContent, after: workingContent }
    if (previousContent === null) return null
    return { before: previousContent, after: versionContent }
  }, [view, compare, versionContent, previousContent, workingContent])

  const recover = useCallback(() => {
    if (versionContent === null) return
    onRecover(versionContent)
    setOpen(false)
  }, [versionContent, onRecover])

  const fork = useCallback(() => {
    if (versionContent === null) return
    onFork(versionContent)
    setOpen(false)
  }, [versionContent, onFork])

  return {
    open,
    onOpenChange: setOpen,
    openHistory,
    reset,
    historyPath,
    commits,
    error,
    hasMore,
    loadingMore,
    renamedFrom,
    canGoBack: historyPathStack.length > 0,
    selectedSha,
    versionContent,
    versionLoading,
    view,
    onViewChange: setView,
    compare,
    onCompareChange: setCompare,
    diff,
    diffLoading: previousLoading,
    diffNote,
    onSelect: selectVersion,
    onLoadMore: () => void loadMore(),
    onViewBeforeRename: () => void viewBeforeRename(),
    onBack: () => void goBack(),
    onRecover: recover,
    onFork: fork,
  }
}
