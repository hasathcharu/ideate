'use client'

import { Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export default function ReplaceExportModal({
  open, onOpenChange, path, branch, busy, onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  path: string | null
  branch: string
  busy: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><TriangleAlert className="text-amber-500" /> Replace existing file?</DialogTitle>
          <DialogDescription>
            <code>{path}</code> already exists on <code>{branch}</code>.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The generated image will replace its current contents in a new commit. Its previous version remains available in Git history.
        </p>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 className="animate-spin" /> : null} Replace file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
