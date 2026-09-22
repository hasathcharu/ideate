'use client'

import { Plus, RefreshCw, Search, X } from 'lucide-react'
import FileTree, { FileTreeSkeleton } from './FileTree'
import NewFileMenu from './NewFileMenu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { FileKind } from '@/lib/tree'
import type { TreeNode } from '@/lib/types'

export interface WorkspaceSidebarProps {
  width: number
  dirtyCount: number
  repoBranch: string | null
  treeLoading: boolean
  onRefresh: () => void
  newHint: string
  onNewFile: (dir: string | undefined, kind: FileKind) => void
  onUploadImage: (dir?: string) => void
  hasDisplayNodes: boolean
  fileFilter: string
  onFileFilterChange: (value: string) => void
  searching: boolean
  truncated: boolean
  treeError: string | null
  treeLoaded: boolean
  localMode: boolean
  visibleNodes: TreeNode[]
  activePath: string | null
  dirtyPaths: ReadonlySet<string>
  expandedPaths: ReadonlySet<string>
  onToggleDir: (path: string) => void
  onOpenFile: (path: string) => void
  onDelete: (node: TreeNode) => void
  onRename: (node: TreeNode) => void
}

/** File navigation for the selected workspace. All persistence stays in AppShell commands. */
export default function WorkspaceSidebar({
  width,
  dirtyCount,
  repoBranch,
  treeLoading,
  onRefresh,
  newHint,
  onNewFile,
  onUploadImage,
  hasDisplayNodes,
  fileFilter,
  onFileFilterChange,
  searching,
  truncated,
  treeError,
  treeLoaded,
  localMode,
  visibleNodes,
  activePath,
  dirtyPaths,
  expandedPaths,
  onToggleDir,
  onOpenFile,
  onDelete,
  onRename,
}: WorkspaceSidebarProps) {
  const clearFilter = () => onFileFilterChange('')

  return (
    <aside className="flex flex-none flex-col overflow-hidden bg-sidebar" style={{ width }}>
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
          Files
          {dirtyCount > 0 ? (
            <span
              className="size-1.5 shrink-0 rounded-full bg-amber-500"
              title={`${dirtyCount} unsaved file${dirtyCount === 1 ? '' : 's'}`}
              aria-label={`${dirtyCount} unsaved file${dirtyCount === 1 ? '' : 's'}`}
            />
          ) : null}
        </span>
        <div className="flex items-center gap-0.5">
          {repoBranch !== null ? (
            <Button size="icon-xs" variant="ghost" onClick={onRefresh} disabled={treeLoading} title="Refresh files">
              <RefreshCw className={cn(treeLoading && 'animate-spin')} />
            </Button>
          ) : null}
          <NewFileMenu onSelect={(kind) => onNewFile(undefined, kind)} onUploadImage={() => onUploadImage()}>
            <Button size="icon-xs" variant="ghost" title={`New file at root (${newHint})`}>
              <Plus />
            </Button>
          </NewFileMenu>
        </div>
      </div>
      {hasDisplayNodes ? (
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={fileFilter}
              onChange={(event) => onFileFilterChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  clearFilter()
                }
              }}
              placeholder="Search files"
              aria-label="Search files"
              className="h-7 bg-background pr-7 pl-7 text-xs"
            />
            {searching ? (
              <button
                type="button"
                onClick={clearFilter}
                aria-label="Clear search"
                title="Clear search"
                className="absolute top-1/2 right-1.5 flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <Separator />
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {truncated ? (
          <p className="mb-2 rounded-md bg-muted p-2 text-xs text-muted-foreground">
            ⚠ Large repo; some files may be hidden.
          </p>
        ) : null}
        {treeError && treeLoaded ? (
          <p className="mb-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">{treeError}</p>
        ) : null}
        {treeError && !treeLoaded ? (
          <p className="p-2 text-sm text-destructive">{treeError}</p>
        ) : !localMode && !treeLoaded ? (
          <FileTreeSkeleton />
        ) : (
          <FileTree
            nodes={visibleNodes}
            activePath={activePath}
            dirtyPaths={dirtyPaths}
            expandedPaths={expandedPaths}
            onToggleDir={onToggleDir}
            branch={repoBranch ?? ''}
            searchQuery={searching ? fileFilter.trim() : undefined}
            onOpenFile={onOpenFile}
            onDelete={onDelete}
            onNewFile={onNewFile}
            onUploadImage={onUploadImage}
            onRename={onRename}
          />
        )}
      </div>
    </aside>
  )
}
