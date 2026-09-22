'use client'

import { ArrowLeft, FileDiff, Map, Plug, PlugZap, Settings2, WrapText } from 'lucide-react'
import { ExcalidrawIcon, MarkdownIcon, MermaidIcon } from './icons'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LAYOUT_ENGINES } from '@/lib/mermaid'
import { setLayoutInYaml } from '@/lib/mermaidConfig'
import { THEME_PRESETS } from '@/lib/themes'
import type { AgentLink } from '@/lib/agentLink'
import type { AppConfig } from '@/lib/types'
import type { FileKind } from '@/lib/tree'

export interface DocumentToolbarProps {
  hasWorkspace: boolean
  linkTrail: ReadonlyArray<{ path: string; scrollTop: number }>
  onBack: () => void
  openPath: string | null
  localMode: boolean
  kind: FileKind
  onSwitchScratchKind: (kind: FileKind) => void
  showDiff: boolean
  canDiff: boolean
  onToggleDiff: () => void
  config: AppConfig
  updateConfig: (patch: Partial<AppConfig>) => void
  currentTheme: string
  customThemeValue: string
  noneThemeValue: string
  onApplyTheme: (value: string) => void
  currentLayout: string
  onOpenConfig: () => void
  linkAttached: boolean
  linkWaiting: boolean
  agentLinkOn: boolean
  agentLink: AgentLink
  onOpenAgentLink: () => void
}

/** Controls for the active document surface; commands are supplied by the shell. */
export default function DocumentToolbar({
  hasWorkspace,
  linkTrail,
  onBack,
  openPath,
  localMode,
  kind,
  onSwitchScratchKind,
  showDiff,
  canDiff,
  onToggleDiff,
  config,
  updateConfig,
  currentTheme,
  customThemeValue,
  noneThemeValue,
  onApplyTheme,
  currentLayout,
  onOpenConfig,
  linkAttached,
  linkWaiting,
  agentLinkOn,
  agentLink,
  onOpenAgentLink,
}: DocumentToolbarProps) {
  const backPath = linkTrail[linkTrail.length - 1]?.path

  return (
    <div className="flex flex-none flex-wrap items-center gap-1.5 border-b px-3 py-2 text-xs text-muted-foreground">
      {hasWorkspace && backPath ? (
        <Button size="icon-xs" variant="ghost" onClick={onBack} title={`Back to ${backPath}`} aria-label={`Back to ${backPath}`}>
          <ArrowLeft />
        </Button>
      ) : null}
      {hasWorkspace ? (
        <span>{openPath ?? (localMode ? 'untitled (unsaved)' : 'untitled (unsaved local draft)')}</span>
      ) : (
        <span>Connect a repository to browse and commit your diagrams.</span>
      )}
      {localMode ? <span className="text-muted-foreground/70">· local mode, files stay in this browser</span> : null}
      {!openPath ? (
        <div className="ml-1 flex items-center gap-0.5 rounded-md border p-0.5">
          <Button size="sm" variant={kind === 'markdown' ? 'secondary' : 'ghost'} className="h-6 gap-1 px-2 text-xs" onClick={() => onSwitchScratchKind('markdown')}>
            <MarkdownIcon className="size-3" /> Markdown
          </Button>
          <Button size="sm" variant={kind === 'mermaid' ? 'secondary' : 'ghost'} className="h-6 gap-1 px-2 text-xs" onClick={() => onSwitchScratchKind('mermaid')}>
            <MermaidIcon className="size-3" /> Diagram
          </Button>
          <Button size="sm" variant={kind === 'excalidraw' ? 'secondary' : 'ghost'} className="h-6 gap-1 px-2 text-xs" onClick={() => onSwitchScratchKind('excalidraw')}>
            <ExcalidrawIcon className="size-3" /> Canvas
          </Button>
        </div>
      ) : null}
      <div className="ml-auto flex items-center gap-1.5">
        {kind !== 'excalidraw' ? (
          <Button
            size="icon-sm"
            variant={showDiff && canDiff ? 'secondary' : 'ghost'}
            className="size-7"
            onClick={onToggleDiff}
            disabled={!canDiff}
            aria-pressed={showDiff && canDiff}
            aria-label="Compare with the last commit"
            title={canDiff ? (showDiff ? 'Back to the editor' : 'Compare with the last commit') : 'Nothing committed yet to compare with'}
          >
            <FileDiff />
          </Button>
        ) : null}
        {kind !== 'excalidraw' ? (
          <Button size="icon-sm" variant={config.wrapLines ? 'secondary' : 'ghost'} className="size-7" onClick={() => updateConfig({ wrapLines: !config.wrapLines })} aria-pressed={config.wrapLines} aria-label="Wrap long lines" title={config.wrapLines ? 'Wrap long lines: on' : 'Wrap long lines: off'}>
            <WrapText />
          </Button>
        ) : null}
        {kind !== 'excalidraw' ? (
          <Button size="icon-sm" variant={config.minimap ? 'secondary' : 'ghost'} className="size-7" onClick={() => updateConfig({ minimap: !config.minimap })} aria-pressed={config.minimap} aria-label="Viewfinder" title={config.minimap ? 'Viewfinder: on' : 'Viewfinder: off'}>
            <Map />
          </Button>
        ) : null}
        <span className="text-muted-foreground">Theme</span>
        <Select value={currentTheme} onValueChange={onApplyTheme}>
          <SelectTrigger size="sm" className="h-7 w-48" aria-label="Diagram theme"><SelectValue /></SelectTrigger>
          <SelectContent align="end">
            <SelectItem value={noneThemeValue} className="cursor-pointer" onFocus={() => onApplyTheme(noneThemeValue)}>None (default)</SelectItem>
            {currentTheme === customThemeValue ? <SelectItem value={customThemeValue} disabled>Custom</SelectItem> : null}
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Light</SelectLabel>
              {THEME_PRESETS.filter((preset) => preset.mode === 'light').map((preset) => (
                <SelectItem key={preset.value} value={preset.value} className="cursor-pointer" onFocus={() => onApplyTheme(preset.value)}>{preset.label}</SelectItem>
              ))}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Dark</SelectLabel>
              {THEME_PRESETS.filter((preset) => preset.mode === 'dark').map((preset) => (
                <SelectItem key={preset.value} value={preset.value} className="cursor-pointer" onFocus={() => onApplyTheme(preset.value)}>{preset.label}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {kind !== 'excalidraw' ? (
          <>
            <span className="text-muted-foreground">Layout</span>
            <Select value={currentLayout} onValueChange={(value) => updateConfig({ mermaidConfig: setLayoutInYaml(config.mermaidConfig, value) })}>
              <SelectTrigger size="sm" className="h-7" aria-label="Layout engine"><SelectValue /></SelectTrigger>
              <SelectContent align="end">
                {LAYOUT_ENGINES.map((engine) => <SelectItem key={engine.value} value={engine.value}>{engine.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="icon-sm" variant="ghost" className="size-7" onClick={onOpenConfig} aria-label="Diagram configuration" title="Diagram configuration">
              <Settings2 />
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant={linkAttached ? 'secondary' : 'ghost'}
          className={linkAttached ? 'h-7 gap-1.5 text-primary' : 'h-7 gap-1.5'}
          onClick={onOpenAgentLink}
          aria-pressed={agentLinkOn}
          title={
            !agentLinkOn
              ? 'Agent Link — let a coding agent read and edit this document'
              : linkAttached
                ? `Agent Link — ${agentLink.agent ?? 'an agent'} is attached and can edit this document`
                : agentLink.status === 'full'
                  ? 'Agent Link — the shared service is at capacity. Run your own and point this tab at it in Advanced options'
                  : agentLink.status === 'blocked'
                    ? `Agent Link — blocked: ${agentLink.detail ?? 'see the console'}`
                    : linkWaiting
                      ? `Agent Link — on. Give your agent the code ${agentLink.code}; it must attach before it can read or edit`
                      : 'Agent Link — on, connecting to the service'
          }
        >
          {linkAttached ? <PlugZap /> : <Plug />}
          {linkAttached ? 'Agent Connected' : agentLinkOn ? 'Awaiting Agent' : 'Connect Agent'}
        </Button>
      </div>
    </div>
  )
}
