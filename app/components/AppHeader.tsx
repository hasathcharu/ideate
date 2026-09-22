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
import ExportMenu from './ExportMenu'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { APP_NAME } from '@/lib/config'
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
  canSave: boolean
  saving: boolean
  showSaveAll: boolean
  saveAllPaths: readonly string[]
  saveHint: string
  isMac: boolean
  onSaveAll: () => void
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
  canSave,
  saving,
  showSaveAll,
  saveAllPaths,
  saveHint,
  isMac,
  onSaveAll,
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
}: AppHeaderProps) {
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
          <div className="ml-1 flex items-center gap-1 rounded-full border border-border bg-background p-0.5 dark:border-input dark:bg-input/30">
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
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
                className="size-7 shrink-0 rounded-full"
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
                <SquareArrowOutUpRight />
              </Button>
            ) : null}
          </div>
        ) : null}
        {githubEnabled && repo ? (
          <Button size="sm" variant="outline" className="h-8 rounded-full" onClick={onOpenBranchPicker}>
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
                onClick={onSave}
                disabled={!canSave}
                className={showSaveAll ? 'rounded-r-none' : undefined}
                title={`${localMode ? 'Save' : 'Commit'} this file (${saveHint})`}
              >
                {localMode ? 'Save' : saving ? 'Committing…' : 'Commit'}
                <kbd className="ml-1 flex items-center gap-0.5 rounded border border-current/30 px-1 text-[10px] leading-none font-medium opacity-70">
                  {isMac ? <><Command className="size-2.5" /> <span>S</span></> : <span>Ctrl + S</span>}
                </kbd>
              </Button>
              {showSaveAll ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      disabled={saving}
                      className="rounded-l-none border-l border-primary-foreground/30 px-1.5"
                      aria-label={`More save actions — ${saveAllPaths.length} unsaved files`}
                      title={`${saveAllPaths.length} unsaved files`}
                    >
                      <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuItem onClick={onSaveAll} className="flex-col items-start gap-0.5">
                      <span>{localMode ? 'Save all' : 'Commit all'} ({saveAllPaths.length} files)</span>
                      <span className="text-xs text-muted-foreground">
                        {localMode ? 'Writes every changed file to this browser.' : 'All of them in a single commit.'}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Unsaved</DropdownMenuLabel>
                    {saveAllPaths.slice(0, MAX_LISTED_UNSAVED).map((path) => (
                      <DropdownMenuItem key={path} onClick={() => onOpenPath(path)} className="text-xs">
                        <span className="truncate">{path}</span>
                      </DropdownMenuItem>
                    ))}
                    {saveAllPaths.length > MAX_LISTED_UNSAVED ? (
                      <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        and {saveAllPaths.length - MAX_LISTED_UNSAVED} more
                      </p>
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
        <ExportMenu
          text={exportText}
          baseName={baseName}
          configYaml={config.mermaidConfig}
          background={config.exportBackground}
          onBackgroundChange={(value) => updateConfig({ exportBackground: value })}
          pngScale={config.pngScale}
          onPngScaleChange={(value) => updateConfig({ pngScale: value })}
          config={appliedConfig}
          kind={kind}
        />
        <Separator orientation="vertical" className="h-6" />
        <AuthButton user={user} />
      </div>
    </header>
  )
}
