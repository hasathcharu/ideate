'use client'

import { useEffect, useRef, useState } from 'react'
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
  /** Fixed text before the editable part — the target directory, when creating a
   *  file. Not editable, and included in what `validate`/`onSubmit` receive. */
  prefix?: string
  /** Fixed text after the editable part — the file extension, when creating a
   *  file, since the kind was already chosen in the menu that opened this. */
  suffix?: string
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
  prefix = '',
  suffix = '',
  submitLabel = 'Create',
  validate,
  onSubmit,
}: PromptModalProps) {
  const [value, setValue] = useState(defaultValue)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open) {
      setValue(defaultValue)
      setError(null)
    }
  }, [open, defaultValue])

  // Select the editable part on open, so the suggested name can be replaced by
  // typing. Deferred a frame: the dialog moves focus itself as it opens, and
  // selecting before that would be undone.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => inputRef.current?.select())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const submit = () => {
    const trimmed = value.trim()
    const full = `${prefix}${trimmed}${suffix}`
    const validationError = validate ? validate(full) : trimmed ? null : 'Required.'
    if (validationError) {
      setError(validationError)
      return
    }
    onSubmit(full)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submit()
  }
  // A fixed prefix/suffix is shown *around* the field rather than inside it, so
  // the parts that can't change look like they can't.
  const segmented = prefix !== '' || suffix !== ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="prompt-input">{label}</Label>
          {segmented ? (
            <div className="flex h-9 items-center rounded-md border border-input bg-transparent px-3 py-1 font-mono text-sm shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
              {prefix ? (
                <span className="shrink-0 text-muted-foreground select-none">{prefix}</span>
              ) : null}
              <input
                ref={inputRef}
                id="prompt-input"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value)
                  setError(null)
                }}
                onKeyDown={onKeyDown}
                autoFocus
              />
              {suffix ? (
                <span className="shrink-0 text-muted-foreground select-none">{suffix}</span>
              ) : null}
            </div>
          ) : (
            <Input
              ref={inputRef}
              id="prompt-input"
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
              onKeyDown={onKeyDown}
              autoFocus
            />
          )}
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
