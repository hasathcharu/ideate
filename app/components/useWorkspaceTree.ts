'use client'

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { buildTree, collectDirPaths, collectFilePaths, pathMatchesQuery } from '@/lib/tree'
import { workspaceKey, type WorkspaceStore } from '@/lib/workspaceStore'
import type { TreeResult } from '@/app/actions/github'

const EMPTY_PATHS: ReadonlySet<string> = new Set()

export interface WorkspaceTreeOptions {
  localMode: boolean
  localPaths: readonly string[] | null
  tree: TreeResult | null
  hasWorkspace: boolean
  openPath: string | null
  loadedSha: string | null
  openDocumentDirty: boolean
  selectedWorkspaceKey: string
  workspaceStore: WorkspaceStore
}

/** Derives sidebar existence, dirty state, filtering, and expansion from document records. */
export function useWorkspaceTree({
  localMode,
  localPaths,
  tree,
  hasWorkspace,
  openPath,
  loadedSha,
  openDocumentDirty,
  selectedWorkspaceKey,
  workspaceStore,
}: WorkspaceTreeOptions) {
  const [createdPaths, setCreatedPaths] = useState<ReadonlySet<string>>(new Set())
  const [legacyDirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set())
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set())
  const [fileFilter, setFileFilterState] = useState('')
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(EMPTY_PATHS)
  const storeRecords = useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.snapshot,
    workspaceStore.snapshot,
  )

  const savedPaths = useMemo<ReadonlySet<string> | null>(() => {
    if (localMode) return localPaths === null ? null : new Set(localPaths)
    return tree ? new Set(tree.tree.flatMap(collectFilePaths)) : null
  }, [localMode, localPaths, tree])

  const pendingPaths = useMemo<ReadonlySet<string>>(() => {
    const next = new Set<string>()
    for (const path of createdPaths) if (!savedPaths?.has(path)) next.add(path)
    if (hasWorkspace && openPath && loadedSha === null) next.add(openPath)
    for (const record of storeRecords) {
      if (workspaceKey(record.identity.workspace) !== selectedWorkspaceKey) continue
      if (record.identity.path && record.exists && record.savedRevision === null &&
          !savedPaths?.has(record.identity.path)) next.add(record.identity.path)
    }
    return next
  }, [savedPaths, createdPaths, hasWorkspace, openPath, loadedSha, storeRecords, selectedWorkspaceKey])

  const dirtyPaths = useMemo<ReadonlySet<string>>(() => {
    const next = new Set(legacyDirtyPaths)
    for (const record of storeRecords) {
      if (!record.identity.path || workspaceKey(record.identity.workspace) !== selectedWorkspaceKey) continue
      if (record.persistence === 'clean') next.delete(record.identity.path)
      else next.add(record.identity.path)
    }
    return next
  }, [legacyDirtyPaths, storeRecords, selectedWorkspaceKey])

  useEffect(() => {
    if (!openPath) return
    setDirtyPaths((previous) => {
      if (openDocumentDirty === previous.has(openPath)) return previous
      const next = new Set(previous)
      if (openDocumentDirty) next.add(openPath)
      else next.delete(openPath)
      return next
    })
  }, [openPath, openDocumentDirty])

  const onToggleDir = useCallback((path: string) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const displayNodes = useMemo(() => {
    const base = localMode ? buildTree([...(localPaths ?? [])]) : (tree?.tree ?? [])
    if (pendingPaths.size === 0) return base
    const paths = base.flatMap(collectFilePaths)
    for (const path of pendingPaths) if (!paths.includes(path)) paths.push(path)
    return buildTree(paths)
  }, [localMode, localPaths, tree, pendingPaths])

  const searching = fileFilter.trim().length > 0
  const visibleNodes = useMemo(() => {
    if (!searching) return displayNodes
    const matching = displayNodes
      .flatMap(collectFilePaths)
      .filter((path) => pathMatchesQuery(path, fileFilter))
    return buildTree(matching)
  }, [displayNodes, fileFilter, searching])

  const visibleExpanded = useMemo<ReadonlySet<string>>(() => {
    if (!searching) return expandedPaths
    return new Set(
      visibleNodes.flatMap(collectDirPaths).filter((path) => !searchCollapsed.has(path)),
    )
  }, [searching, visibleNodes, expandedPaths, searchCollapsed])

  const toggleVisibleDir = useCallback((path: string) => {
    if (!searching) {
      onToggleDir(path)
      return
    }
    setSearchCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [searching, onToggleDir])

  const setFileFilter = useCallback((value: string) => {
    setFileFilterState(value)
    setSearchCollapsed(EMPTY_PATHS)
  }, [])
  const resetExpandedPaths = useCallback(() => setExpandedPaths(new Set()), [])

  const repoFilePaths = useMemo(() => displayNodes.flatMap(collectFilePaths), [displayNodes])

  return {
    createdPaths,
    setCreatedPaths,
    dirtyPaths,
    setDirtyPaths,
    savedPaths,
    pendingPaths,
    displayNodes,
    visibleNodes,
    visibleExpanded,
    fileFilter,
    setFileFilter,
    searching,
    toggleVisibleDir,
    repoFilePaths,
    resetExpandedPaths,
  }
}
