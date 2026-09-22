'use client'

import Link from 'next/link'
import {
  ChevronDown,
  Command,
  FolderGit2,
  GitBranch,
  GitPullRequestArrow,
  History,
  PanelLeft,
  RotateCcw,
  SquareArrowOutUpRight,
} from 'lucide-react'
import AuthButton from './AuthButton'
import ExportMenu, { type ExportMenuProps } from './ExportMenu'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { APP_NAME } from '@/lib/config'
import { cn, HEADER_ACTION_BUTTON } from '@/lib/utils'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import type { FileKind } from '@/lib/tree'
import type { AppConfig, RepoRef, SessionUser } from '@/lib/types'

const MAX_LISTED_UNSAVED = 6

export interface AppHeaderProps {
  githubEnabled: boolean
  hasWorkspace: boolean
  sidebarOpen: boolean
  onToggleSidebar: () => void
  sidebarHint: string
  repo: RepoRef | null
  onOpenRepoPicker: () => void
  onOpenBranchPicker: () => void
  onRestore: () => void
  canRestore: boolean
  localMode: boolean
  onSave: () => void
  onCommitWithMessage: () => void
  canSave: boolean
  saving: boolean
  showSaveAll: boolean
  saveAllPaths: readonly string[]
  saveHint: string
  isMac: boolean
  onSaveAll: () => void
  onCommitAllWithMessage: () => void
  onOpenPath: (path: string) => void
  dirty: boolean
  openPath: string | null
  onOpenHistory: () => void
  exportText: string
  baseName: string
  config: AppConfig
  updateConfig: (patch: Partial<AppConfig>) => void
  appliedConfig: MermaidUserConfig | null
  kind: FileKind
  user: SessionUser | null
  onSaveExport?: ExportMenuProps['onSaveToRepository']
  showExport?: boolean
}

/** Global app header. It receives UI state and intent callbacks, not document-store access. */
export default function AppHeader({
  githubEnabled,
  hasWorkspace,
  sidebarOpen,
  onToggleSidebar,
  sidebarHint,
  repo,
  onOpenRepoPicker,
  onOpenBranchPicker,
  onRestore,
  canRestore,
  localMode,
  onSave,
  onCommitWithMessage,
  canSave,
  saving,
  showSaveAll,
  saveAllPaths,
  saveHint,
  isMac,
  onSaveAll,
  onCommitAllWithMessage,
  onOpenPath,
  dirty,
  openPath,
  onOpenHistory,
  exportText,
  baseName,
  config,
  updateConfig,
  appliedConfig,
  kind,
  user,
  onSaveExport,
  showExport = true,
}: AppHeaderProps) {
  const primaryCommitIsCustom = !localMode && config.preferredCommitAction === 'custom'
  /** The commit control is a split button: a primary action plus a menu half. The two
   *  halves drop the default `bg-clip-padding` gutter so the page colour can't bleed
   *  through their transparent borders and read as a hard seam down the middle. */
  const splitCommit = !localMode || showSaveAll

  return (
    <header className="flex flex-none items-center justify-between gap-4 border-b bg-card px-4 py-2">
      <div className="flex items-center gap-2">
        {hasWorkspace ? (
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onToggleSidebar}
            title={`${sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'} (${sidebarHint})`}
          >
            <PanelLeft />
          </Button>
        ) : null}
        <Link href="/" className="text-xl font-bold hover:text-primary">
          {APP_NAME}
        </Link>
        {githubEnabled ? (
          <div className="ml-1 flex h-7 items-center gap-0.5 rounded-full border border-border bg-background p-px dark:border-input dark:bg-input/30">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 rounded-full px-2 text-xs"
              onClick={onOpenRepoPicker}
              title={repo ? 'Switch repository' : 'Connect a repository'}
            >
              <FolderGit2 />
              {repo ? `${repo.owner}/${repo.name}` : 'Connect repo'}
            </Button>
            {repo ? (
              <Button
                size="icon-sm"
                variant="ghost"
                className="size-6 shrink-0 rounded-full"
                onClick={() =>
                  window.open(
                    `https://github.com/${repo.owner}/${repo.name}/tree/${encodeURIComponent(repo.branch)}`,
                    '_blank',
                    'noopener,noreferrer',
                  )
                }
                title={`Open ${repo.owner}/${repo.name} on GitHub`}
                aria-label={`Open ${repo.owner}/${repo.name} on GitHub`}
              >
                <SquareArrowOutUpRight className="size-3" strokeWidth={2.5} />
              </Button>
            ) : null}
          </div>
        ) : null}
        {githubEnabled && repo ? (
          <Button size="sm" variant="outline" className="h-7 rounded-full text-xs" onClick={onOpenBranchPicker}>
            <GitBranch /> {repo.branch}
          </Button>
        ) : null}
        {githubEnabled && repo?.defaultBranch && repo.branch !== repo.defaultBranch ? (
          <Button
            size="sm"
            variant="outline"
            className="rounded-full"
            onClick={() =>
              window.open(
                `https://github.com/${repo.owner}/${repo.name}/compare/${repo.defaultBranch}...${repo.branch}?expand=1`,
                '_blank',
                'noopener,noreferrer',
              )
            }
          >
            <GitPullRequestArrow /> Open PR
          </Button>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {hasWorkspace || githubEnabled ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={onRestore}
              disabled={!canRestore}
              title={localMode ? 'Restore to last save' : 'Restore to last commit'}
            >
              <RotateCcw /> Restore
            </Button>
            <div className="flex items-center">
              <Button
                size="sm"
                onClick={primaryCommitIsCustom ? onCommitWithMessage : onSave}
                disabled={!canSave}
                className={cn(HEADER_ACTION_BUTTON, splitCommit && 'rounded-r-none')}
                title={`${localMode ? 'Save' : 'Commit'} this file (${saveHint})`}
              >
                {localMode ? 'Save' : saving ? 'Committing…' : 'Commit'}
                <kbd className="ml-1 flex items-center gap-0.5 rounded border border-current/30 px-1 py-[3px] text-[10px] leading-none font-medium opacity-70">
                  {isMac ? <><Command className="size-2.5" /> <span>S</span></> : <span>Ctrl + S</span>}
                </kbd>
              </Button>
              {splitCommit ? (
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          disabled={saving}
                          className={cn(HEADER_ACTION_BUTTON, 'rounded-l-none border-l-primary-foreground/20 px-1.5')}
                          aria-label={localMode ? 'More save actions' : 'More commit actions'}
                        >
                          <ChevronDown />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>{localMode ? 'More save actions' : 'More commit actions'}</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end" className="w-64">
                    {showSaveAll ? (
                      <>
                        <DropdownMenuItem
                          onClick={primaryCommitIsCustom ? onCommitAllWithMessage : onSaveAll}
                          className="flex-col items-start gap-0.5"
                        >
                          <span>{localMode ? 'Save all' : 'Commit all'} ({saveAllPaths.length} files)</span>
                          <span className="text-xs text-muted-foreground">
                            {localMode
                              ? 'Writes every changed file to this browser.'
                              : 'All of them in a single commit.'}
                          </span>
                        </DropdownMenuItem>
                      </>
                    ) : null}
                    {showSaveAll ? <DropdownMenuSeparator /> : null}
                    {showSaveAll ? <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Unsaved</DropdownMenuLabel> : null}
                    {showSaveAll ? saveAllPaths.slice(0, MAX_LISTED_UNSAVED).map((path) => (
                      <DropdownMenuItem key={path} onClick={() => onOpenPath(path)} className="text-xs">
                        <span className="truncate">{path}</span>
                      </DropdownMenuItem>
                    )) : null}
                    {saveAllPaths.length > MAX_LISTED_UNSAVED ? (
                      <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        and {saveAllPaths.length - MAX_LISTED_UNSAVED} more
                      </p>
                    ) : null}
                    {!localMode ? (
                      <>
                        {showSaveAll ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuCheckboxItem
                          checked={primaryCommitIsCustom}
                          // Toggling the preference is not a save action, so keep the menu
                          // open — it reads as a setting, and closing on it hides the result.
                          onSelect={(e) => e.preventDefault()}
                          onCheckedChange={(checked) => updateConfig({
                            preferredCommitAction: checked ? 'custom' : 'generated',
                          })}
                        >
                          Custom commit message
                        </DropdownMenuCheckboxItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
            <span className="text-xs text-muted-foreground">{dirty ? '● Unsaved' : 'Saved'}</span>
            {openPath && repo ? (
              <Button size="sm" variant="ghost" onClick={onOpenHistory}>
                <History /> History
              </Button>
            ) : null}
            <Separator orientation="vertical" className="h-6" />
          </>
        ) : null}
        {showExport ? <ExportMenu
          text={exportText}
          baseName={baseName}
          configYaml={config.mermaidConfig}
          background={config.exportBackground}
          onBackgroundChange={(value) => updateConfig({ exportBackground: value })}
          pngScale={config.pngScale}
          onPngScaleChange={(value) => updateConfig({ pngScale: value })}
          svgTheme={config.svgTheme}
          onSvgThemeChange={(value) => updateConfig({ svgTheme: value })}
          exportFrame={config.exportFrame}
          onExportFrameChange={(value) => updateConfig({ exportFrame: value })}
          config={appliedConfig}
          kind={kind}
          onSaveToRepository={onSaveExport}
        /> : null}
        <Separator orientation="vertical" className="h-6" />
        <AuthButton user={user} />
      </div>
    </header>
  )
}
