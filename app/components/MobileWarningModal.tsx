'use client'

import { Smartphone } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { APP_NAME } from '@/lib/config'

export interface MobileWarningModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function MobileWarningModal({ open, onOpenChange }: MobileWarningModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="size-5 text-amber-500" /> Small screen detected
          </DialogTitle>
          <DialogDescription>
            {APP_NAME}&nbsp;needs room for the editor and preview side by side, so it isn&apos;t built
            for phone-sized screens. Some things may be cramped or hard to use.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Continue anyway</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
