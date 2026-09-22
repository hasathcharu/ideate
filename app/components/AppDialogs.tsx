'use client'

import AgentLinkModal from './AgentLinkModal'
import BranchPicker from './BranchPicker'
import ConfigModal from './ConfigModal'
import ConflictModal from './ConflictModal'
import DeleteModal from './DeleteModal'
import HistoryPanel from './HistoryPanel'
import MobileWarningModal from './MobileWarningModal'
import PromptModal, { type PromptModalProps } from './PromptModal'
import RepoPicker from './RepoPicker'
import type { HistoryController } from './useHistoryController'
import { collectFilePaths, type FileKind } from '@/lib/tree'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import type { AgentLink } from '@/lib/agentLink'
import type { Repo, RepoRef, TreeNode } from '@/lib/types'

type PromptSpec = Omit<PromptModalProps, 'open' | 'onOpenChange'>

export interface AppDialogsProps {
  githubEnabled: boolean
  repoPickerOpen: boolean
  onRepoPickerOpenChange: (open: boolean) => void
  onSelectRepo: (repo: Repo) => void
  repo: RepoRef | null
  branchPickerOpen: boolean
  onBranchPickerOpenChange: (open: boolean) => void
  branchBusy: boolean
  onSelectBranch: (branch: string) => void
  onCreateBranch: (branch: string) => void
  openPath: string | null
  conflictOpen: boolean
  onConflictOpenChange: (open: boolean) => void
  conflictBusy: boolean
  onOverwrite: () => void
  onStartOver: () => void
  reconciliation: boolean
  prompt: PromptSpec | null
  promptOpen: boolean
  onPromptOpenChange: (open: boolean) => void
  configOpen: boolean
  onConfigOpenChange: (open: boolean) => void
  mermaidConfig: string
  onMermaidConfigChange: (value: string) => void
  configError: string | null
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
  agentLinkOn: boolean
  onAgentLinkEnabledChange: (enabled: boolean) => void
  agentLink: AgentLink
  mcpOrigin: string
  onMcpOriginChange: (origin: string | null) => void
  mode: 'local' | 'github'
  deleteOpen: boolean
  onDeleteOpenChange: (open: boolean) => void
  deleteTarget: TreeNode | null
  deleteBusy: boolean
  onConfirmDelete: () => void
  history: HistoryController
  appliedConfig: MermaidUserConfig | null
  kind: FileKind
  canvasTheme: 'light' | 'dark'
  canvasBackground: string | undefined
  mobileWarningOpen: boolean
  onMobileWarningOpenChange: (open: boolean) => void
}

/** Modal/sheet composition kept separate from working-copy commands. */
export default function AppDialogs({
  githubEnabled,
  repoPickerOpen,
  onRepoPickerOpenChange,
  onSelectRepo,
  repo,
  branchPickerOpen,
  onBranchPickerOpenChange,
  branchBusy,
  onSelectBranch,
  onCreateBranch,
  openPath,
  conflictOpen,
  onConflictOpenChange,
  conflictBusy,
  onOverwrite,
  onStartOver,
  reconciliation,
  prompt,
  promptOpen,
  onPromptOpenChange,
  configOpen,
  onConfigOpenChange,
  mermaidConfig,
  onMermaidConfigChange,
  configError,
  linkOpen,
  onLinkOpenChange,
  agentLinkOn,
  onAgentLinkEnabledChange,
  agentLink,
  mcpOrigin,
  onMcpOriginChange,
  mode,
  deleteOpen,
  onDeleteOpenChange,
  deleteTarget,
  deleteBusy,
  onConfirmDelete,
  history,
  appliedConfig,
  kind,
  canvasTheme,
  canvasBackground,
  mobileWarningOpen,
  onMobileWarningOpenChange,
}: AppDialogsProps) {
  return (
    <>
      {githubEnabled ? (
        <RepoPicker open={repoPickerOpen} onOpenChange={onRepoPickerOpenChange} onSelect={onSelectRepo} />
      ) : null}
      {githubEnabled && repo ? (
        <BranchPicker
          open={branchPickerOpen}
          onOpenChange={onBranchPickerOpenChange}
          owner={repo.owner}
          name={repo.name}
          currentBranch={repo.branch}
          defaultBranch={repo.defaultBranch}
          creating={branchBusy}
          onSelect={onSelectBranch}
          onCreate={onCreateBranch}
        />
      ) : null}
      {openPath ? (
        <ConflictModal
          open={conflictOpen}
          onOpenChange={onConflictOpenChange}
          path={openPath}
          branch={repo?.branch ?? ''}
          busy={conflictBusy}
          onOverwrite={onOverwrite}
          onStartOver={onStartOver}
          reconciliation={reconciliation}
        />
      ) : null}
      {prompt ? <PromptModal open={promptOpen} onOpenChange={onPromptOpenChange} {...prompt} /> : null}
      <ConfigModal
        open={configOpen}
        onOpenChange={onConfigOpenChange}
        value={mermaidConfig}
        onChange={onMermaidConfigChange}
        error={configError}
      />
      <AgentLinkModal
        open={linkOpen}
        onOpenChange={onLinkOpenChange}
        enabled={agentLinkOn}
        onEnabledChange={onAgentLinkEnabledChange}
        status={agentLink.status}
        detail={agentLink.detail}
        agent={agentLink.agent}
        code={agentLink.code}
        onRegenerate={agentLink.regenerate}
        onRetry={agentLink.retry}
        mcpOrigin={mcpOrigin}
        onMcpOriginChange={onMcpOriginChange}
        mode={mode}
      />
      <DeleteModal
        open={deleteOpen}
        onOpenChange={onDeleteOpenChange}
        target={deleteTarget}
        fileCount={deleteTarget ? collectFilePaths(deleteTarget).length : 0}
        branch={repo?.branch ?? ''}
        localMode={mode === 'local'}
        busy={deleteBusy}
        onConfirm={onConfirmDelete}
      />
      {openPath ? (
        <HistoryPanel
          open={history.open}
          onOpenChange={history.onOpenChange}
          path={openPath}
          historyPath={history.historyPath ?? openPath}
          commits={history.commits}
          error={history.error}
          hasMore={history.hasMore}
          loadingMore={history.loadingMore}
          renamedFrom={history.renamedFrom}
          canGoBack={history.canGoBack}
          selectedSha={history.selectedSha}
          versionContent={history.versionContent}
          versionLoading={history.versionLoading}
          config={appliedConfig}
          kind={kind}
          canvasTheme={canvasTheme}
          canvasBackground={canvasBackground}
          view={history.view}
          onViewChange={history.onViewChange}
          compare={history.compare}
          onCompareChange={history.onCompareChange}
          diff={history.diff}
          diffLoading={history.diffLoading}
          diffNote={history.diffNote}
          onSelect={history.onSelect}
          onLoadMore={history.onLoadMore}
          onViewBeforeRename={history.onViewBeforeRename}
          onBack={history.onBack}
          onRecover={history.onRecover}
          onFork={history.onFork}
        />
      ) : null}
      <MobileWarningModal open={mobileWarningOpen} onOpenChange={onMobileWarningOpenChange} />
    </>
  )
}
