'use client'

import { useState } from 'react'
import { ChevronDown, Copy, Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { DiagramColors } from 'beautiful-mermaid'
import {
  copyPNG,
  copySVG,
  exportPDF,
  exportPNG,
  exportSVG,
} from '@/lib/export'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface ExportMenuProps {
  text: string
  colors: DiagramColors | null
  baseName: string
  includeBackground: boolean
  onToggleBackground: (value: boolean) => void
}

export default function ExportMenu({
  text,
  colors,
  baseName,
  includeBackground,
  onToggleBackground,
}: ExportMenuProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const disabled = !colors || !text.trim()

  const run = async (key: string, label: string, fn: () => Promise<void>) => {
    if (!colors) return
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
        <DropdownMenuCheckboxItem
          checked={includeBackground}
          onCheckedChange={(v) => onToggleBackground(Boolean(v))}
          onSelect={(e) => e.preventDefault()}
        >
          Bake in theme background
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {colors ? (
          <>
            <Row
              label="SVG"
              format="SVG"
              onDownload={() => exportSVG(text, colors, `${name}.svg`, includeBackground)}
              onCopy={() => copySVG(text, colors, includeBackground)}
            />
            <Row
              label="PNG"
              format="PNG"
              onDownload={() => exportPNG(text, colors, `${name}.png`, includeBackground)}
              onCopy={() => copyPNG(text, colors, includeBackground)}
            />
            <Row
              label="PDF (vector)"
              format="PDF"
              onDownload={() => exportPDF(text, colors, `${name}.pdf`, includeBackground)}
            />
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
