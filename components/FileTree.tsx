'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, FileCode, Pencil, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TreeNode } from '@/lib/types'

export interface FileTreeProps {
  nodes: TreeNode[]
  activePath: string | null
  /** Path with unsaved changes (shown with a dot); may be a not-yet-saved file. */
  dirtyPath: string | null
  /** The branch being browsed, for the empty-state copy. */
  branch: string
  onOpenFile: (path: string) => void
  onDelete: (node: TreeNode) => void
  /** Create a new file inside this directory (path prefilled). */
  onNewFile: (dirPath: string) => void
  onRename: (node: TreeNode) => void
}

export default function FileTree({
  nodes,
  activePath,
  dirtyPath,
  branch,
  onOpenFile,
  onDelete,
  onNewFile,
  onRename,
}: FileTreeProps) {
  if (nodes.length === 0) {
    return (
      <p className="px-2 py-3 text-sm leading-relaxed text-muted-foreground">
        No <code>.md</code> / <code>.mmd</code> / <code>.mermaid</code> files found on{' '}
        <code>{branch}</code>.
      </p>
    )
  }
  return (
    <ul className="text-sm">
      {nodes.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          dirtyPath={dirtyPath}
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
  dirtyPath: string | null
  onOpenFile: (path: string) => void
  onDelete: (node: TreeNode) => void
  onNewFile: (dirPath: string) => void
  onRename: (node: TreeNode) => void
}

function TreeItem(props: ItemProps) {
  const { node, depth, activePath, dirtyPath, onOpenFile, onDelete, onNewFile, onRename } =
    props
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: `${depth * 12 + 8}px` }

  if (node.type === 'dir') {
    // Dot when an unsaved file lives somewhere inside this folder.
    const dirty = !!dirtyPath && dirtyPath.startsWith(`${node.path}/`)
    return (
      <li>
        <div className="group flex items-center rounded-md text-muted-foreground hover:bg-accent">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1"
            style={pad}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? (
              <ChevronDown className="size-3.5 shrink-0" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {dirty ? <UnsavedDot /> : null}
          <IconAction
            title={`New file in ${node.name}`}
            onClick={() => onNewFile(node.path)}
          >
            <Plus className="size-3.5" />
          </IconAction>
          <IconAction
            title={`Delete folder ${node.name}`}
            danger
            onClick={() => onDelete(node)}
          >
            <Trash2 className="size-3.5" />
          </IconAction>
        </div>
        {open && node.children ? (
          <ul>
            {node.children.map((child) => (
              <TreeItem key={child.path} {...props} node={child} depth={depth + 1} />
            ))}
          </ul>
        ) : null}
      </li>
    )
  }

  const active = activePath === node.path
  const dirty = dirtyPath === node.path
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
          <FileCode className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate">{node.name}</span>
        </button>
        {dirty ? <UnsavedDot /> : null}
        <IconAction title={`Rename ${node.name}`} onClick={() => onRename(node)}>
          <Pencil className="size-3.5" />
        </IconAction>
        <IconAction title={`Delete ${node.name}`} danger onClick={() => onDelete(node)}>
          <Trash2 className="size-3.5" />
        </IconAction>
      </div>
    </li>
  )
}

/** Amber dot marking unsaved changes; hidden on hover to reveal the actions. */
function UnsavedDot() {
  return (
    <span
      className="mr-1.5 size-1.5 shrink-0 rounded-full bg-amber-500 group-hover:hidden"
      title="Unsaved changes"
      aria-label="Unsaved changes"
    />
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
        'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition last:mr-1 hover:bg-accent-foreground/10 focus-visible:opacity-100 group-hover:opacity-100',
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
