'use client'

import { useState, type CSSProperties } from 'react'
import {
  ChevronDown,
  Copy,
  Download,
  FolderInput,
  Loader2,
  SquareDashedTopSolid,
  SquareRoundCorner,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  copyMarkdownSource,
  copyPNG,
  copySource,
  copySVG,
  exportMarkdownSource,
  exportPNG,
  exportSource,
  exportSVG,
  renderPngBlob,
  resolveStandaloneSvg,
} from '@/lib/export'
import {
  copySceneSource,
  copyScenePNG,
  copySceneSVG,
  exportSceneSource,
  exportScenePNG,
  exportSceneSVG,
  renderScenePngBlob,
  resolveSceneSvg,
} from '@/lib/exportScene'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import { EXCALIDRAW_EXTENSION, type FileKind } from '@/lib/tree'
import type { ExportBackground, PngScale, SvgThemeMode } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

/* ------------------------------------------------------------------ */
/* PNG resolution                                                      */
/* ------------------------------------------------------------------ */

/** The one-click densities. 2× is the default. */
const SCALE_PRESETS: ReadonlyArray<{ label: string; title: string; spec: PngScale }> = [
  { label: '1×', title: 'The diagram’s natural pixel size', spec: { mode: 'multiplier', value: 1 } },
  { label: '2×', title: 'Twice the diagram’s natural pixel size', spec: { mode: 'multiplier', value: 2 } },
  { label: '3×', title: 'Three times the diagram’s natural pixel size', spec: { mode: 'multiplier', value: 3 } },
]

/** The axes a custom size can be stated on. Width and height are deliberately
 *  exclusive rather than a pair of fields: the drawing's aspect ratio already
 *  fixes whichever one isn't given, so a second field could only ever be
 *  ignored or be a contradiction. */
type CustomUnit = 'dpi' | 'width' | 'height'

const CUSTOM_UNITS: ReadonlyArray<{ value: CustomUnit; label: string; suffix: string }> = [
  { value: 'dpi', label: 'DPI', suffix: 'dpi' },
  { value: 'width', label: 'Width', suffix: 'px' },
  { value: 'height', label: 'Height', suffix: 'px' },
]

/** Starting value when a unit is picked, so switching axes never leaves the
 *  field holding a number that means something else (300 px wide, say). */
const CUSTOM_DEFAULTS: Record<CustomUnit, number> = { dpi: 300, width: 1920, height: 1080 }

function isCustomScale(spec: PngScale): spec is PngScale & { mode: CustomUnit } {
  return spec.mode === 'dpi' || spec.mode === 'width' || spec.mode === 'height'
}

function scaleMatches(spec: PngScale, preset: PngScale): boolean {
  if (spec.mode !== preset.mode) return false
  return spec.value === preset.value
}

export interface ExportMenuProps {
  text: string
  baseName: string
  /** Raw YAML text of the global mermaid config, for the "Mermaid + Config" export. */
  configYaml: string
  background: ExportBackground
  onBackgroundChange: (value: ExportBackground) => void
  /** How dense a PNG export is rasterized. */
  pngScale: PngScale
  onPngScaleChange: (value: PngScale) => void
  svgTheme: SvgThemeMode
  onSvgThemeChange: (value: SvgThemeMode) => void
  exportFrame: boolean
  onExportFrameChange: (value: boolean) => void
  /** Global mermaid config (theme, layout, per-diagram settings) to render exports with. */
  config?: MermaidUserConfig | null
  /** Which exporter to use. Excalidraw ships its own, so scenes don't go through
   *  the mermaid render path at all. */
  kind?: FileKind
  onSaveToRepository?: (
    format: 'SVG' | 'PNG',
    extension: '.svg' | '.png',
    create: () => Promise<{ content: string | Blob; encoding: 'utf8' | 'binary' }>,
  ) => void
}

export default function ExportMenu({
  text,
  baseName,
  configYaml,
  background,
  onBackgroundChange,
  pngScale,
  onPngScaleChange,
  svgTheme,
  onSvgThemeChange,
  exportFrame,
  onExportFrameChange,
  config = null,
  kind = 'mermaid',
  onSaveToRepository,
}: ExportMenuProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const isScene = kind === 'excalidraw'
  const isMarkdown = kind === 'markdown'
  const disabled = !text.trim()

  const custom = isCustomScale(pngScale)
  const customUnit: CustomUnit = custom ? pngScale.mode : 'dpi'

  /** What the custom field is showing, when that is not simply the committed spec. */
  const [customDraft, setCustomDraft] = useState<string | null>(null)
  const customValue = customDraft ?? (custom ? String(pngScale.value) : '')

  const commitCustom = (unit: CustomUnit, raw: string) => {
    setCustomDraft(raw)
    const value = Number(raw)
    if (!raw.trim() || !Number.isFinite(value) || value <= 0) return
    onPngScaleChange({ mode: unit, value })
  }

  const selectCustomUnit = (unit: CustomUnit) => {
    // Back to showing the spec: the number about to be committed is this unit's
    // default, and a draft left over from the previous axis would hide it.
    setCustomDraft(null)
    onPngScaleChange({ mode: unit, value: CUSTOM_DEFAULTS[unit] })
  }

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

  /** PNG density, rendered directly under the PNG row it belongs to. */
  const pngResolution = (
    <div className="px-2 pt-0.5 pb-2">
      <div className="flex items-center gap-0.5 rounded-md border p-0.5">
        {SCALE_PRESETS.map((preset) => {
          const active = scaleMatches(pngScale, preset.spec)
          return (
            <Button
              key={preset.label}
              size="sm"
              variant={active ? 'secondary' : 'ghost'}
              className="h-6 flex-1 px-1 text-xs"
              title={preset.title}
              aria-pressed={active}
              onClick={() => onPngScaleChange(preset.spec)}
            >
              {preset.label}
            </Button>
          )
        })}
        <Button
          size="sm"
          variant={custom ? 'secondary' : 'ghost'}
          className="h-6 flex-1 px-1 text-xs"
          title="Set an exact DPI, width or height"
          aria-pressed={custom}
          onClick={() => {
            if (!custom) selectCustomUnit('dpi')
          }}
        >
          Custom
        </Button>
      </div>
      {custom ? (
        <>
          <div className="mt-1.5 flex items-center gap-1.5">
            <div className="flex items-center gap-0.5 rounded-md border p-0.5">
              {CUSTOM_UNITS.map((unit) => (
                <Button
                  key={unit.value}
                  size="sm"
                  variant={customUnit === unit.value ? 'secondary' : 'ghost'}
                  className="h-6 px-1.5 text-xs"
                  aria-pressed={customUnit === unit.value}
                  onClick={() => selectCustomUnit(unit.value)}
                >
                  {unit.label}
                </Button>
              ))}
            </div>
            <div className="relative flex-1">
              <Input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                aria-label={`Export ${customUnit}`}
                value={customValue}
                onChange={(e) => commitCustom(customUnit, e.target.value)}
                // The dropdown's typeahead treats every character key as a menu
                // search, which steals focus the moment a digit is typed. The
                // field has to keep its own keystrokes.
                onKeyDown={(e) => e.stopPropagation()}
                className="h-6 pr-7 text-xs"
              />
              <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-muted-foreground">
                {CUSTOM_UNITS.find((u) => u.value === customUnit)?.suffix}
              </span>
            </div>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            {customUnit === 'dpi'
              ? 'Pixels per inch, against the 96 DPI a CSS pixel is defined at.'
              : `The ${customUnit === 'width' ? 'height' : 'width'} follows from the drawing’s aspect ratio.`}
          </p>
        </>
      ) : null}
    </div>
  )

  const svgThemeControl = (
    <div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-2">
      <span className="text-xs text-muted-foreground">Theme</span>
      <div className="flex items-center gap-0.5 rounded-md border p-0.5">
        {(['forced', 'dynamic'] as const).map((mode) => (
          <Button
            key={mode}
            size="sm"
            variant={svgTheme === mode ? 'secondary' : 'ghost'}
            className="h-6 px-2 text-xs capitalize"
            aria-pressed={svgTheme === mode}
            onClick={() => onSvgThemeChange(mode)}
          >
            {mode}
          </Button>
        ))}
      </div>
    </div>
  )

  const Row = ({
    label,
    format,
    onDownload,
    onCopy,
    onSave,
  }: {
    label: string
    format: string
    onDownload: () => Promise<void>
    onCopy?: () => Promise<void>
    onSave?: () => void
  }) => (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={busy !== null}
              aria-label={`Download ${format}`}
              onClick={() => run(`dl-${format}`, `${format} downloaded`, onDownload)}
            >
              {busy === `dl-${format}` ? <Loader2 className="animate-spin" /> : <Download />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download {format}</TooltipContent>
        </Tooltip>
        {onCopy ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={busy !== null}
                aria-label={`Copy ${format} to clipboard`}
                onClick={() => run(`cp-${format}`, `${format} copied to clipboard`, onCopy)}
              >
                {busy === `cp-${format}` ? <Loader2 className="animate-spin" /> : <Copy />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy {format}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="inline-block size-6" />
        )}
        {onSave ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={busy !== null}
                aria-label={`Save ${format} to repository`}
                onClick={onSave}
              >
                <FolderInput />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Save {format} to repository</TooltipContent>
          </Tooltip>
        ) : null}
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
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>
          {isScene ? 'Export canvas' : isMarkdown ? 'Export document' : 'Export diagram'}
        </DropdownMenuLabel>
        {/* Both markdown exports are the source text itself, and text has no
            background to paint — the swatches would be a control that changes
            nothing. The preview still paints the theme background on screen. */}
        {isMarkdown ? null : (
          <>
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
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <span className="text-sm">Frame</span>
              <div className="flex items-center gap-0.5 rounded-md border p-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-xs"
                      variant={!exportFrame ? 'secondary' : 'ghost'}
                      aria-label="Plain frame"
                      aria-pressed={!exportFrame}
                      onClick={() => onExportFrameChange(false)}
                    >
                      <SquareDashedTopSolid />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Plain</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-xs"
                      variant={exportFrame ? 'secondary' : 'ghost'}
                      aria-label="Padded rounded frame"
                      aria-pressed={exportFrame}
                      onClick={() => onExportFrameChange(true)}
                    >
                      <SquareRoundCorner />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Padded and rounded</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {isMarkdown ? (
          <>
            <Row
              label="Markdown"
              format="Markdown"
              onDownload={() => exportMarkdownSource(text, `${name}.md`)}
              onCopy={() => copyMarkdownSource(text)}
            />
          </>
        ) : isScene ? (
          <>
            <Row
              label="SVG"
              format="SVG"
              onDownload={() => exportSceneSVG(text, `${name}.svg`, background, config, svgTheme, exportFrame)}
              onCopy={() => copySceneSVG(text, background, config, svgTheme, exportFrame)}
              onSave={onSaveToRepository ? () => onSaveToRepository('SVG', '.svg', async () => ({
                content: (await resolveSceneSvg(text, background, config, svgTheme, exportFrame)).markup, encoding: 'utf8',
              })) : undefined}
            />
            {svgThemeControl}
            <Row
              label="PNG"
              format="PNG"
              onDownload={() => exportScenePNG(text, `${name}.png`, background, config, pngScale, exportFrame)}
              onCopy={() => copyScenePNG(text, background, config, pngScale, exportFrame)}
              onSave={onSaveToRepository ? () => onSaveToRepository('PNG', '.png', async () => ({
                content: await renderScenePngBlob(text, background, config, pngScale, exportFrame), encoding: 'binary',
              })) : undefined}
            />
            {pngResolution}
            <DropdownMenuSeparator />
            <Row
              label="Excalidraw scene"
              format="Scene"
              onDownload={() => exportSceneSource(text, `${name}${EXCALIDRAW_EXTENSION}`)}
              onCopy={() => copySceneSource(text)}
            />
          </>
        ) : (
          <>
            <Row
              label="SVG"
              format="SVG"
              onDownload={() => exportSVG(text, `${name}.svg`, background, config, { themeMode: svgTheme, framed: exportFrame })}
              onCopy={() => copySVG(text, background, config, { themeMode: svgTheme, framed: exportFrame })}
              onSave={onSaveToRepository ? () => onSaveToRepository('SVG', '.svg', async () => ({
                content: (await resolveStandaloneSvg(text, { background, config, themeMode: svgTheme, framed: exportFrame })).markup, encoding: 'utf8',
              })) : undefined}
            />
            {svgThemeControl}
            <Row
              label="PNG"
              format="PNG"
              onDownload={() => exportPNG(text, `${name}.png`, background, config, pngScale, exportFrame)}
              onCopy={() => copyPNG(text, background, config, pngScale, exportFrame)}
              onSave={onSaveToRepository ? () => onSaveToRepository('PNG', '.png', async () => ({
                content: await renderPngBlob(text, background, config, pngScale, exportFrame), encoding: 'binary',
              })) : undefined}
            />
            {pngResolution}
            <DropdownMenuSeparator />
            <Row
              label="Mermaid + Config"
              format="MMD"
              onDownload={() => exportSource(text, `${name}.mmd`, configYaml)}
              onCopy={() => copySource(text, configYaml)}
            />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
