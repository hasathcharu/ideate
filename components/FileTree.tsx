'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, FileCode, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TreeNode } from '@/lib/types'

export interface FileTreeProps {
  nodes: TreeNode[]
  activePath: string | null
  /** Path with unsaved changes (shown with a dot); may be a not-yet-saved file. */
  dirtyPath: string | null
  onOpenFile: (path: string) => void
  onDelete: (node: TreeNode) => void
}

export default function FileTree({
  nodes,
  activePath,
  dirtyPath,
  onOpenFile,
  onDelete,
}: FileTreeProps) {
  if (nodes.length === 0) {
    return (
      <p className="px-2 py-3 text-sm leading-relaxed text-muted-foreground">
        No <code>.md</code> / <code>.mmd</code> / <code>.mermaid</code> files found on{' '}
        <code>main</code>.
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
}

function TreeItem({ node, depth, activePath, dirtyPath, onOpenFile, onDelete }: ItemProps) {
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
          <DeleteButton node={node} onDelete={onDelete} />
        </div>
        {open && node.children ? (
          <ul>
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                dirtyPath={dirtyPath}
                onOpenFile={onOpenFile}
                onDelete={onDelete}
              />
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
        <DeleteButton node={node} onDelete={onDelete} />
      </div>
    </li>
  )
}

/** Amber dot marking unsaved changes; hidden on hover to reveal the delete button. */
function UnsavedDot() {
  return (
    <span
      className="mr-1.5 size-1.5 shrink-0 rounded-full bg-amber-500 group-hover:hidden"
      title="Unsaved changes"
      aria-label="Unsaved changes"
    />
  )
}

function DeleteButton({
  node,
  onDelete,
}: {
  node: TreeNode
  onDelete: (node: TreeNode) => void
}) {
  return (
    <button
      type="button"
      className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
      title={node.type === 'dir' ? `Delete folder ${node.name}` : `Delete ${node.name}`}
      onClick={(e) => {
        e.stopPropagation()
        onDelete(node)
      }}
    >
      <Trash2 className="size-3.5" />
    </button>
  )
}
