'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface PromptModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  label: string
  defaultValue?: string
  submitLabel?: string
  validate?: (value: string) => string | null
  onSubmit: (value: string) => void
}

export default function PromptModal({
  open,
  onOpenChange,
  title,
  description,
  label,
  defaultValue = '',
  submitLabel = 'Create',
  validate,
  onSubmit,
}: PromptModalProps) {
  const [value, setValue] = useState(defaultValue)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setValue(defaultValue)
      setError(null)
    }
  }, [open, defaultValue])

  const submit = () => {
    const trimmed = value.trim()
    const validationError = validate ? validate(trimmed) : trimmed ? null : 'Required.'
    if (validationError) {
      setError(validationError)
      return
    }
    onSubmit(trimmed)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="prompt-input">{label}</Label>
          <Input
            id="prompt-input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            autoFocus
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>{submitLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
