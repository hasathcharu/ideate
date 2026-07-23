'use client'

import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { TreeNode } from '@/lib/types'

export interface DeleteModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: TreeNode | null
  /** How many diagram files the delete will remove (1 for a file). */
  fileCount: number
  branch: string
  busy: boolean
  onConfirm: () => void
}

export default function DeleteModal({
  open,
  onOpenChange,
  target,
  fileCount,
  branch,
  busy,
  onConfirm,
}: DeleteModalProps) {
  const isDir = target?.type === 'dir'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isDir ? 'Delete folder' : 'Delete file'}</DialogTitle>
          <DialogDescription>
            {isDir ? (
              <>
                Remove <code>{target?.path}</code> and its {fileCount} diagram file
                {fileCount === 1 ? '' : 's'} from <code>{branch}</code>.
              </>
            ) : (
              <>
                Remove <code>{target?.path}</code> from <code>{branch}</code>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This commits a removal to <code>{branch}</code>. The history stays in Git, you can
          restore it on GitHub.
        </p>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Delete{isDir && fileCount > 1 ? ` ${fileCount} files` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
