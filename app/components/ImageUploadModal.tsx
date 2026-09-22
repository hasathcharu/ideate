'use client'

import { useEffect, useRef, useState } from 'react'
import { ImageUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const ACCEPT = '.png,.jpg,.gif,.svg,image/png,image/jpeg,image/gif,image/svg+xml'
const SUPPORTED = /\.(png|jpg|gif|svg)$/i

export default function ImageUploadModal({
  open, onOpenChange, directory, busy, onUpload,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  directory: string
  busy: boolean
  onUpload: (file: File, path: string) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setFile(null)
    setPath(directory ? `${directory}/` : '')
    setError(null)
  }, [open, directory])

  const choose = (next: File | undefined) => {
    if (!next) return
    if (!SUPPORTED.test(next.name)) {
      setError('Choose a PNG, JPG, GIF, or SVG file.')
      return
    }
    setFile(next)
    setPath(`${directory ? `${directory}/` : ''}${next.name}`)
    setError(null)
  }

  const submit = () => {
    if (!file) return setError('Choose an image to upload.')
    const value = path.trim()
    if (!value || value.startsWith('/') || value.split('/').includes('..')) {
      return setError('Use a repository-relative path.')
    }
    if (!SUPPORTED.test(value)) return setError('Use a .png, .jpg, .gif, or .svg extension.')
    const sourceExtension = file.name.match(/\.(png|jpg|gif|svg)$/i)?.[1]?.toLowerCase()
    const targetExtension = value.match(/\.(png|jpg|gif|svg)$/i)?.[1]?.toLowerCase()
    if (sourceExtension !== targetExtension) return setError('Keep the image’s original file extension.')
    onUpload(file, value)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload image</DialogTitle>
          <DialogDescription>Upload a PNG, JPG, GIF, or SVG without changing its bytes.</DialogDescription>
        </DialogHeader>
        <button
          type="button"
          className="flex min-h-36 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-input bg-muted/20 p-6 text-sm text-muted-foreground hover:bg-muted/40"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files[0]) }}
        >
          <ImageUp className="size-8" />
          <span>{file ? file.name : 'Drop an image here, or click to choose'}</span>
          {file ? <span className="text-xs">{(file.size / 1024 / 1024).toFixed(2)} MB</span> : null}
        </button>
        <input ref={inputRef} type="file" accept={ACCEPT} hidden onChange={(event) => choose(event.target.files?.[0])} />
        <div className="space-y-2">
          <Label htmlFor="image-upload-path">Location</Label>
          <Input id="image-upload-path" value={path} onChange={(event) => { setPath(event.target.value); setError(null) }} />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
