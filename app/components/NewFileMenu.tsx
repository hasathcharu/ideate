'use client'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ExcalidrawIcon, MarkdownIcon, MermaidIcon } from './icons'
import { ImageUp } from 'lucide-react'
import type { FileKind } from '@/lib/tree'

export interface NewFileMenuProps {
  /** Which kind of file to start. The caller turns this into a path prompt. */
  onSelect: (kind: FileKind) => void
  onUploadImage: () => void
  triggerTooltip?: string
  /** The trigger element — passed through `asChild`, so each call site keeps its
   *  own styling (the sidebar header's button looks nothing like the file tree's
   *  hover-revealed row actions). Must not set its own `onClick`; Radix owns it. */
  children: React.ReactNode
}

/**
 * The "new file" kind picker, shared by the sidebar's root **+** and every folder's **+** so the
 * two can't drift apart.
 */
export default function NewFileMenu({ onSelect, onUploadImage, triggerTooltip, children }: NewFileMenuProps) {
  return (
    <DropdownMenu>
      {triggerTooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{triggerTooltip}</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      )}
      {/* `align="start"` anchors the menu's *left* edge to the trigger so it opens
          rightward; `end` would anchor the right edge and push it back over the
          sidebar. `min-w-52` + non-wrapping items keep each label on one line — at
          the default menu width "Excalidraw canvas" wraps onto a second row. */}
      <DropdownMenuContent align="start" className="min-w-52">
        {/* Markdown first: a document is the most common thing to start, and it
            can hold diagrams of either kind inside it. */}
        <DropdownMenuItem className="whitespace-nowrap" onSelect={() => onSelect('markdown')}>
          <MarkdownIcon /> Markdown document
        </DropdownMenuItem>
        <DropdownMenuItem className="whitespace-nowrap" onSelect={() => onSelect('mermaid')}>
          <MermaidIcon /> Mermaid diagram
        </DropdownMenuItem>
        <DropdownMenuItem className="whitespace-nowrap" onSelect={() => onSelect('excalidraw')}>
          <ExcalidrawIcon /> Excalidraw canvas
        </DropdownMenuItem>
        <DropdownMenuItem className="whitespace-nowrap" onSelect={onUploadImage}>
          <ImageUp /> Upload image
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
