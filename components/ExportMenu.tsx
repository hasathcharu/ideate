'use client'

import { useState } from 'react'
import { ChevronDown, Copy, Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  copyPNG,
  copySVG,
  exportPNG,
  exportSVG,
} from '@/lib/export'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface ExportMenuProps {
  text: string
  baseName: string
  includeBackground: boolean
  onToggleBackground: (value: boolean) => void
}

export default function ExportMenu({
  text,
  baseName,
  includeBackground,
  onToggleBackground,
}: ExportMenuProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const disabled = !text.trim()

  const run = async (key: string, label: string, fn: () => Promise<void>) => {
    setBusy(key)
    try {
      await fn()
      toast.success(label)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setBusy(null)
    }
  }

  const name = baseName || 'diagram'

  const Row = ({
    label,
    format,
    onDownload,
    onCopy,
  }: {
    label: string
    format: string
    onDownload: () => Promise<void>
    onCopy?: () => Promise<void>
  }) => (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-1">
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={busy !== null}
          title={`Download ${format}`}
          onClick={() => run(`dl-${format}`, `${format} downloaded`, onDownload)}
        >
          {busy === `dl-${format}` ? <Loader2 className="animate-spin" /> : <Download />}
        </Button>
        {onCopy ? (
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={busy !== null}
            title={`Copy ${format} to clipboard`}
            onClick={() => run(`cp-${format}`, `${format} copied to clipboard`, onCopy)}
          >
            {busy === `cp-${format}` ? <Loader2 className="animate-spin" /> : <Copy />}
          </Button>
        ) : (
          <span className="inline-block size-6" />
        )}
      </div>
    </div>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary" disabled={disabled}>
          Export <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Export diagram</DropdownMenuLabel>
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <span className="text-sm">With Background</span>
          <Switch
            checked={includeBackground}
            onCheckedChange={(v) => onToggleBackground(Boolean(v))}
          />
        </div>
        <DropdownMenuSeparator />
        <Row
          label="SVG"
          format="SVG"
          onDownload={() => exportSVG(text, `${name}.svg`, includeBackground)}
          onCopy={() => copySVG(text, includeBackground)}
        />
        <Row
          label="PNG"
          format="PNG"
          onDownload={() => exportPNG(text, `${name}.png`, includeBackground)}
          onCopy={() => copyPNG(text, includeBackground)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
