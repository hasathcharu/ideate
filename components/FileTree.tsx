'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, FileCode } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TreeNode } from '@/lib/types'

export interface FileTreeProps {
  nodes: TreeNode[]
  activePath: string | null
  onOpenFile: (path: string) => void
}

export default function FileTree({ nodes, activePath, onOpenFile }: FileTreeProps) {
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
        <TreeItem key={node.path} node={node} depth={0} activePath={activePath} onOpenFile={onOpenFile} />
      ))}
    </ul>
  )
}

function TreeItem({
  node,
  depth,
  activePath,
  onOpenFile,
}: {
  node: TreeNode
  depth: number
  activePath: string | null
  onOpenFile: (path: string) => void
}) {
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: `${depth * 12 + 8}px` }

  if (node.type === 'dir') {
    return (
      <li>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-muted-foreground hover:bg-accent"
          style={pad}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children ? (
          <ul>
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                onOpenFile={onOpenFile}
              />
            ))}
          </ul>
        ) : null}
      </li>
    )
  }

  const active = activePath === node.path
  return (
    <li>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md py-1 pr-2 hover:bg-accent',
          active && 'bg-primary/15 text-primary hover:bg-primary/20',
        )}
        style={pad}
        title={node.path}
        onClick={() => onOpenFile(node.path)}
      >
        <FileCode className="size-3.5 shrink-0 opacity-70" />
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  )
}
