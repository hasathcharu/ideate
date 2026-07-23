'use client'

import { useState, type CSSProperties } from 'react'
import { ChevronDown, Copy, Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  copyPNG,
  copySource,
  copySVG,
  exportPNG,
  exportSource,
  exportSVG,
} from '@/lib/export'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import type { ExportBackground } from '@/lib/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const BACKGROUND_OPTIONS: ReadonlyArray<{ value: ExportBackground; label: string }> = [
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
  { value: 'none', label: 'None (transparent)' },
  { value: 'theme', label: 'Theme' },
]

/** A repeating checkerboard, the universal "transparent" indicator. */
const TRANSPARENT_PATTERN: CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, #80808066 25%, transparent 25%), linear-gradient(-45deg, #80808066 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #80808066 75%), linear-gradient(-45deg, transparent 75%, #80808066 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
}

function swatchStyle(
  value: ExportBackground,
  themeBg: string | undefined,
): CSSProperties {
  switch (value) {
    case 'white':
      return { background: '#ffffff' }
    case 'black':
      return { background: '#000000' }
    case 'none':
      return TRANSPARENT_PATTERN
    case 'theme':
      return { background: themeBg ?? 'linear-gradient(135deg, #6366f1, #ec4899)' }
  }
}

export interface ExportMenuProps {
  text: string
  baseName: string
  /** Raw YAML text of the global mermaid config, for the "Mermaid + Config" export. */
  configYaml: string
  background: ExportBackground
  onBackgroundChange: (value: ExportBackground) => void
  /** Global mermaid config (theme, layout, per-diagram settings) to render exports with. */
  config?: MermaidUserConfig | null
}

export default function ExportMenu({
  text,
  baseName,
  configYaml,
  background,
  onBackgroundChange,
  config = null,
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
  const themeBg =
    typeof config?.themeVariables?.background === 'string'
      ? config.themeVariables.background
      : undefined

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
          <span className="text-sm">Background</span>
          <div className="flex items-center gap-1.5">
            {BACKGROUND_OPTIONS.map((opt) => (
              <Tooltip key={opt.value}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={opt.label}
                    aria-pressed={background === opt.value}
                    onClick={() => onBackgroundChange(opt.value)}
                    className={cn(
                      'size-6 rounded-md border border-input transition-shadow',
                      background === opt.value &&
                        'ring-2 ring-primary ring-offset-1 ring-offset-popover',
                    )}
                    style={swatchStyle(opt.value, themeBg)}
                  />
                </TooltipTrigger>
                <TooltipContent>{opt.label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
        <DropdownMenuSeparator />
        <Row
          label="SVG"
          format="SVG"
          onDownload={() => exportSVG(text, `${name}.svg`, background, config)}
          onCopy={() => copySVG(text, background, config)}
        />
        <Row
          label="PNG"
          format="PNG"
          onDownload={() => exportPNG(text, `${name}.png`, background, config)}
          onCopy={() => copyPNG(text, background, config)}
        />
        <DropdownMenuSeparator />
        <Row
          label="Mermaid + Config"
          format="MMD"
          onDownload={() => exportSource(text, `${name}.mmd`, configYaml)}
          onCopy={() => copySource(text, configYaml)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
