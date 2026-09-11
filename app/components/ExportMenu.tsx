'use client'

import { useState, type CSSProperties } from 'react'
import { ChevronDown, Copy, Download, Loader2 } from 'lucide-react'
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
} from '@/lib/export'
import {
  copySceneSource,
  copyScenePNG,
  copySceneSVG,
  exportSceneSource,
  exportScenePNG,
  exportSceneSVG,
} from '@/lib/exportScene'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import { EXCALIDRAW_EXTENSION, type FileKind } from '@/lib/tree'
import type { ExportBackground, PngScale } from '@/lib/types'
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

/** The one-click densities. `auto` is first and is the default: it is the only
 *  option that reads the diagram's own size, and it is right far more often than
 *  any fixed multiplier. */
const SCALE_PRESETS: ReadonlyArray<{ label: string; title: string; spec: PngScale }> = [
  { label: 'Auto', title: 'Size-aware — small diagrams are scaled up, large ones stay dense', spec: { mode: 'auto' } },
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
  return spec.mode === 'auto' || preset.mode === 'auto' || spec.value === preset.value
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
  /** Global mermaid config (theme, layout, per-diagram settings) to render exports with. */
  config?: MermaidUserConfig | null
  /** Which exporter to use. Excalidraw ships its own, so scenes don't go through
   *  the mermaid render path at all. */
  kind?: FileKind
}

export default function ExportMenu({
  text,
  baseName,
  configYaml,
  background,
  onBackgroundChange,
  pngScale,
  onPngScaleChange,
  config = null,
  kind = 'mermaid',
}: ExportMenuProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const isScene = kind === 'excalidraw'
  const isMarkdown = kind === 'markdown'
  const disabled = !text.trim()

  const custom = isCustomScale(pngScale)
  const customUnit: CustomUnit = custom ? pngScale.mode : 'dpi'

  /**
   * What the custom field is showing, when that is not simply the committed spec.
   *
   * A number input has states a `PngScale` cannot represent — empty, and
   * mid-typing values like `"30"` on the way to `"300"` — so the field cannot be
   * driven by the spec alone: the first backspace would commit something and snap
   * the value back. But it cannot be *seeded* from the spec either, which is what
   * a plain `useState` initializer did. `AppConfig` is hydrated from localStorage
   * one render after mount, so the initializer always ran against the default
   * `auto` and left this at `''` — a user who had set 2560px reopened the menu to
   * an empty field above a control insisting it was in width mode.
   *
   * `null` means "whatever is committed", which is the honest answer except while
   * the user is actually typing. So there is no copy to fall out of date.
   */
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

  /**
   * PNG density, rendered directly under the PNG row it belongs to.
   *
   * Placed there rather than beside the background swatches because it modifies
   * exactly one of the formats in the list: next to the shared Background control
   * it read as another global setting, and the SVG row above it was silently
   * exempt. Under the PNG row the scope is the position.
   *
   * The toggles are `Button`s in the same secondary/ghost pairing the toolbar's
   * kind switch uses, rather than hand-rolled classes. Hand-rolled, the pressed
   * state picked `bg-secondary` straight while the surface under it is
   * `--popover`, and the two tokens are close enough in the light theme to look
   * deliberate and far enough apart in the dark one to look broken.
   */
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
              onDownload={() => exportSceneSVG(text, `${name}.svg`, background, config)}
              onCopy={() => copySceneSVG(text, background, config)}
            />
            <Row
              label="PNG"
              format="PNG"
              onDownload={() => exportScenePNG(text, `${name}.png`, background, config, pngScale)}
              onCopy={() => copyScenePNG(text, background, config, pngScale)}
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
              onDownload={() => exportSVG(text, `${name}.svg`, background, config)}
              onCopy={() => copySVG(text, background, config)}
            />
            <Row
              label="PNG"
              format="PNG"
              onDownload={() => exportPNG(text, `${name}.png`, background, config, pngScale)}
              onCopy={() => copyPNG(text, background, config, pngScale)}
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
