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

export interface ConflictModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  path: string
  busy: boolean
  onOverwrite: () => void
  onStartOver: () => void
}

export default function ConflictModal({
  open,
  onOpenChange,
  path,
  busy,
  onOverwrite,
  onStartOver,
}: ConflictModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>This file changed on GitHub</DialogTitle>
          <DialogDescription>
            <code>{path}</code> was updated on <code>main</code> since you opened it, so
            your save was rejected.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">Overwrite</strong> — commit your version
            on top of the latest. Nothing in the history is destroyed.
          </li>
          <li>
            <strong className="text-foreground">Start over</strong> — discard your local
            changes and reload the latest version from GitHub.
          </li>
        </ul>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Keep editing
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onStartOver}>
            {busy ? <Loader2 className="animate-spin" /> : null} Start over
          </Button>
          <Button disabled={busy} onClick={onOverwrite}>
            {busy ? <Loader2 className="animate-spin" /> : null} Overwrite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
