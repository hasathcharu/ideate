'use client'

import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import NewFileMenu from './NewFileMenu'
import { ExcalidrawIcon, MarkdownIcon, MermaidIcon } from './icons'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { DIAGRAM_EXTENSIONS, fileKind, type FileKind } from '@/lib/tree'
import type { TreeNode } from '@/lib/types'

/** Shared styling for the hover-revealed row actions. Extracted so the "new file"
 *  dropdown trigger can match the plain icon buttons beside it. */
const ICON_ACTION_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition last:mr-1 hover:bg-accent-foreground/10 focus-visible:opacity-100 group-hover:opacity-100'

/** The file's icon, matching the one shown for its kind in `NewFileMenu` so the
 *  picker and the resulting file read as the same thing. Full opacity, unlike the
 *  generic glyph it replaced — these carry brand color, so dimming them muddies it. */
function FileKindIcon({ kind }: { kind: FileKind }) {
  const Icon =
    kind === 'excalidraw' ? ExcalidrawIcon : kind === 'markdown' ? MarkdownIcon : MermaidIcon
  return <Icon className="size-3.5 shrink-0" />
}

/** Row shapes for the loading skeleton: indent depth and label width, picked to
 *  look like a plausible small tree (two folders, a few files) rather than a
 *  uniform stack of identical bars. */
const SKELETON_ROWS = [
  { depth: 0, width: 'w-28' },
  { depth: 1, width: 'w-36' },
  { depth: 1, width: 'w-24' },
  { depth: 0, width: 'w-32' },
  { depth: 1, width: 'w-40' },
  { depth: 0, width: 'w-20' },
  { depth: 0, width: 'w-32' },
] as const

/**
 * Placeholder shown while the first tree for a repo/branch loads.
 *
 * Geometry deliberately mirrors `TreeItem`: same `depth * 12 + 8` indent, same
 * `py-1` row height, `gap-1.5` and inter-row `space-y-px`, so the real list
 * doesn't visibly jump when it replaces this.
 */
export function FileTreeSkeleton() {
  return (
    <ul className="space-y-px text-sm" aria-hidden>
      {SKELETON_ROWS.map((row, i) => (
        <li
          key={i}
          className="flex items-center gap-1.5 py-1 pr-1"
          style={{ paddingLeft: `${row.depth * 12 + 8}px` }}
        >
          <Skeleton className="size-3.5 shrink-0" />
          <Skeleton className={cn('h-3.5', row.width)} />
        </li>
      ))}
    </ul>
  )
}

export interface FileTreeProps {
  nodes: TreeNode[]
  activePath: string | null
  /** Paths with unsaved changes (shown with a dot); may include not-yet-saved files. */
  dirtyPaths: ReadonlySet<string>
  /** Directory paths currently expanded — lifted to the caller so it can be
   *  invalidated (e.g. on repo/branch switch) independently of this component. */
  expandedPaths: ReadonlySet<string>
  onToggleDir: (path: string) => void
  /** The branch being browsed, for the empty-state copy. */
  branch: string
  onOpenFile: (path: string) => void
  onDelete: (node: TreeNode) => void
  /** Create a new file of `kind` inside this directory (path prefilled). */
  onNewFile: (dirPath: string, kind: FileKind) => void
  onRename: (node: TreeNode) => void
}

export default function FileTree({
  nodes,
  activePath,
  dirtyPaths,
  expandedPaths,
  onToggleDir,
  branch,
  onOpenFile,
  onDelete,
  onNewFile,
  onRename,
}: FileTreeProps) {
  if (nodes.length === 0) {
    return (
      <p className="px-2 py-3 text-sm leading-relaxed text-muted-foreground">
        No{' '}
        {DIAGRAM_EXTENSIONS.map((ext, i) => (
          <span key={ext}>
            {i > 0 ? ' / ' : ''}
            <code>{ext}</code>
          </span>
        ))}{' '}
        files found on <code>{branch}</code>.
      </p>
    )
  }
  return (
    // `space-y-px` is load-bearing, not spacing taste: a row's hover fill and the
    // active row's tint are both full-width rounded rectangles, so with the rows
    // flush the two backgrounds met edge to edge and read as one selected block.
    // A single pixel of gap is enough to separate them and doesn't change the
    // list's density.
    <ul className="space-y-px text-sm">
      {nodes.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          dirtyPaths={dirtyPaths}
          expandedPaths={expandedPaths}
          onToggleDir={onToggleDir}
          onOpenFile={onOpenFile}
          onDelete={onDelete}
          onNewFile={onNewFile}
          onRename={onRename}
        />
      ))}
    </ul>
  )
}

interface ItemProps {
  node: TreeNode
  depth: number
  activePath: string | null
  dirtyPaths: ReadonlySet<string>
  expandedPaths: ReadonlySet<string>
  onToggleDir: (path: string) => void
  onOpenFile: (path: string) => void
  onDelete: (node: TreeNode) => void
  onNewFile: (dirPath: string, kind: FileKind) => void
  onRename: (node: TreeNode) => void
}

function TreeItem(props: ItemProps) {
  const {
    node,
    depth,
    activePath,
    dirtyPaths,
    expandedPaths,
    onToggleDir,
    onOpenFile,
    onDelete,
    onNewFile,
    onRename,
  } = props
  const pad = { paddingLeft: `${depth * 12 + 8}px` }

  if (node.type === 'dir') {
    const open = expandedPaths.has(node.path)
    // Dot when an unsaved file lives somewhere inside this folder.
    const dirty = Array.from(dirtyPaths).some((p) => p.startsWith(`${node.path}/`))
    return (
      <li>
        <div className="group flex items-center rounded-md text-muted-foreground hover:bg-accent">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1"
            style={pad}
            onClick={() => onToggleDir(node.path)}
          >
            {open ? (
              <ChevronDown className="size-3.5 shrink-0" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
          <div className="relative flex shrink-0 items-center">
            {dirty ? <UnsavedDot /> : null}
            <NewFileMenu onSelect={(kind) => onNewFile(node.path, kind)}>
              <button
                type="button"
                className={ICON_ACTION_CLASS}
                title={`New file in ${node.name}`}
                aria-label={`New file in ${node.name}`}
              >
                <Plus className="size-3.5" />
              </button>
            </NewFileMenu>
            <IconAction
              title={`Delete folder ${node.name}`}
              danger
              onClick={() => onDelete(node)}
            >
              <Trash2 className="size-3.5" />
            </IconAction>
          </div>
        </div>
        {open && node.children ? (
          <ul className="space-y-px pt-px">
            {node.children.map((child) => (
              <TreeItem key={child.path} {...props} node={child} depth={depth + 1} />
            ))}
          </ul>
        ) : null}
      </li>
    )
  }

  const active = activePath === node.path
  const dirty = dirtyPaths.has(node.path)
  return (
    <li>
      <div
        className={cn(
          'group flex items-center rounded-md hover:bg-accent',
          active && 'bg-primary/15 text-primary hover:bg-primary/20',
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1"
          style={pad}
          title={node.path}
          onClick={() => onOpenFile(node.path)}
        >
          <FileKindIcon kind={fileKind(node.path)} />
          <span className="truncate">{node.name}</span>
        </button>
        <div className="relative flex shrink-0 items-center">
          {dirty ? <UnsavedDot /> : null}
          <IconAction title={`Rename ${node.name}`} onClick={() => onRename(node)}>
            <Pencil className="size-3.5" />
          </IconAction>
          <IconAction title={`Delete ${node.name}`} danger onClick={() => onDelete(node)}>
            <Trash2 className="size-3.5" />
          </IconAction>
        </div>
      </div>
    </li>
  )
}

/** Amber dot marking unsaved changes; overlays the action buttons, hidden on hover to reveal them. */
function UnsavedDot() {
  return (
    <span
      className="absolute inset-0 z-10 flex items-center justify-center group-hover:hidden"
      title="Unsaved changes"
      aria-label="Unsaved changes"
    >
      <span className="size-1.5 rounded-full bg-amber-500" />
    </span>
  )
}

function IconAction({
  title,
  onClick,
  danger,
  children,
}: {
  title: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={cn(
        ICON_ACTION_CLASS,
        danger && 'hover:bg-destructive/15 hover:text-destructive',
      )}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}
