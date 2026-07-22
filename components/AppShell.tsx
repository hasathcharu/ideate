'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  ChevronRight,
  FolderGit2,
  History,
  PanelLeft,
  Plus,
  Save,
} from 'lucide-react'
import { toast } from 'sonner'
import Editor from './Editor'
import Preview from './Preview'
import ThemeSelect from './ThemeSelect'
import ExportMenu from './ExportMenu'
import AuthButton from './AuthButton'
import RepoPicker from './RepoPicker'
import FileTree from './FileTree'
import ConflictModal from './ConflictModal'
import PromptModal, { type PromptModalProps } from './PromptModal'
import HistoryPanel from './HistoryPanel'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useChromeTheme, useDebouncedValue, useResolvedTheme } from '@/lib/hooks'
import {
  loadConfig,
  saveConfig,
  loadDraft,
  saveDraft,
  clearDraft,
  docIdForFile,
  SCRATCH_DOC_ID,
} from '@/lib/storage'
import { DEFAULT_THEME_ID } from '@/lib/themes'
import { isDiagramFile } from '@/lib/tree'
import {
  listTree,
  readFile,
  readFileAtRef,
  listFileCommits,
  commitFile,
  type TreeResult,
} from '@/app/actions/github'
import type { AppConfig, FileCommit, Repo, SessionUser } from '@/lib/types'

export interface AppShellProps {
  user: SessionUser | null
  mode: 'local' | 'github'
}

const SAMPLE = `flowchart TD
  A[Working copy in localStorage] -->|Save = commit| B(GitHub repo)
  B --> C{Conflict?}
  C -->|No| D[Committed on main]
  C -->|Yes| E[Refetch sha, commit on top]
  E --> D
`

const NEW_TEMPLATE = `flowchart LR
  A[Start] --> B[End]
`

type PromptSpec = Pick<
  PromptModalProps,
  'title' | 'description' | 'label' | 'defaultValue' | 'submitLabel' | 'validate' | 'onSubmit'
>

export default function AppShell({ user, mode }: AppShellProps) {
  const githubEnabled = mode === 'github' && !!user

  const [config, setConfig] = useState<AppConfig>({
    repo: null,
    themeId: DEFAULT_THEME_ID,
    bakeThemeOnExport: true,
  })
  const [hydrated, setHydrated] = useState(false)

  const [text, setText] = useState(SAMPLE)
  const [baseline, setBaseline] = useState(SAMPLE)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [loadedSha, setLoadedSha] = useState<string | null>(null)

  const [tree, setTree] = useState<TreeResult | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const [saving, setSaving] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)
  const [conflictBusy, setConflictBusy] = useState(false)

  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [prompt, setPrompt] = useState<PromptSpec | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [commits, setCommits] = useState<FileCommit[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [versionContent, setVersionContent] = useState<string | null>(null)
  const [versionLoading, setVersionLoading] = useState(false)

  const debouncedText = useDebouncedValue(text, 350)
  const { colors, dark, loading } = useResolvedTheme(config.themeId)
  useChromeTheme(colors, dark)

  const repo = githubEnabled ? config.repo : null
  const dirty = text !== baseline
  const docId =
    repo && openPath ? docIdForFile(repo.owner, repo.name, openPath) : SCRATCH_DOC_ID
  const baseName = openPath
    ? (openPath.split('/').pop() ?? 'diagram').replace(/\.(md|mmd|mermaid)$/i, '')
    : 'diagram'

  const refreshTree = useCallback(async (target: { owner: string; name: string }) => {
    setTree(null)
    setTreeError(null)
    const res = await listTree(target.owner, target.name)
    if (res.ok) setTree(res.data)
    else setTreeError(res.error.message)
  }, [])

  useEffect(() => {
    const stored = loadConfig()
    setConfig(stored)
    const draft = loadDraft(SCRATCH_DOC_ID)
    if (draft && draft.content !== SAMPLE) {
      setText(draft.content)
      setBaseline(SAMPLE)
    }
    setHydrated(true)
    if (githubEnabled && stored.repo) void refreshTree(stored.repo)
  }, [githubEnabled, refreshTree])

  useEffect(() => {
    if (!hydrated) return
    saveDraft(docId, debouncedText)
  }, [debouncedText, docId, hydrated])

  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const updateConfig = useCallback((patch: Partial<AppConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch }
      saveConfig(next)
      return next
    })
  }, [])

  const openPrompt = useCallback((spec: PromptSpec) => {
    setPrompt(spec)
    setPromptOpen(true)
  }, [])

  const onSelectRepo = useCallback(
    (r: Repo) => {
      updateConfig({ repo: { owner: r.owner, name: r.name } })
      setRepoPickerOpen(false)
      setOpenPath(null)
      setLoadedSha(null)
      void refreshTree({ owner: r.owner, name: r.name })
    },
    [updateConfig, refreshTree],
  )

  const openFile = useCallback(
    async (path: string) => {
      if (!repo) return
      const res = await readFile(repo.owner, repo.name, path)
      if (!res.ok) {
        toast.error(res.error.message)
        return
      }
      const id = docIdForFile(repo.owner, repo.name, path)
      const draft = loadDraft(id)
      setBaseline(res.data.content)
      setLoadedSha(res.data.sha)
      setOpenPath(path)
      setText(draft && draft.content !== res.data.content ? draft.content : res.data.content)
    },
    [repo],
  )

  const newDiagram = useCallback(() => {
    if (!repo) {
      setOpenPath(null)
      setLoadedSha(null)
      setBaseline(NEW_TEMPLATE)
      setText(NEW_TEMPLATE)
      return
    }
    openPrompt({
      title: 'New diagram',
      description: 'Create a new diagram file on main.',
      label: 'File path',
      defaultValue: 'diagrams/untitled.mmd',
      submitLabel: 'Start editing',
      validate: validatePath,
      onSubmit: (path) => {
        setPromptOpen(false)
        setOpenPath(path)
        setLoadedSha(null)
        setBaseline('')
        setText(NEW_TEMPLATE)
      },
    })
  }, [repo, openPrompt])

  const commitCurrent = useCallback(
    async (path: string, sha: string | undefined, content: string) => {
      if (!repo) return
      setSaving(true)
      const res = await commitFile(repo.owner, repo.name, path, content, sha)
      setSaving(false)
      if (res.ok) {
        setBaseline(content)
        setLoadedSha(res.data.sha)
        setOpenPath(path)
        clearDraft(SCRATCH_DOC_ID)
        toast.success(`Committed ${path}`)
        void refreshTree(repo)
        return
      }
      if (res.error.kind === 'conflict') setConflictOpen(true)
      else toast.error(res.error.message)
    },
    [repo, refreshTree],
  )

  const onSave = useCallback(() => {
    if (!repo || !dirty || saving) return
    if (openPath === null) {
      openPrompt({
        title: 'Save to repository',
        description: 'Choose a path on main for this diagram.',
        label: 'File path',
        defaultValue: 'diagrams/untitled.mmd',
        submitLabel: 'Save',
        validate: validatePath,
        onSubmit: (path) => {
          setPromptOpen(false)
          void commitCurrent(path, undefined, text)
        },
      })
      return
    }
    void commitCurrent(openPath, loadedSha ?? undefined, text)
  }, [repo, dirty, saving, openPath, loadedSha, text, commitCurrent, openPrompt])

  const onOverwrite = useCallback(async () => {
    if (!repo || !openPath) return
    setConflictBusy(true)
    const fresh = await readFile(repo.owner, repo.name, openPath)
    if (!fresh.ok) {
      setConflictBusy(false)
      toast.error(fresh.error.message)
      return
    }
    const res = await commitFile(repo.owner, repo.name, openPath, text, fresh.data.sha)
    setConflictBusy(false)
    if (res.ok) {
      setBaseline(text)
      setLoadedSha(res.data.sha)
      setConflictOpen(false)
      clearDraft(docId)
      toast.success('Overwritten on top of latest')
      void refreshTree(repo)
    } else {
      toast.error(res.error.message)
    }
  }, [repo, openPath, text, docId, refreshTree])

  const onStartOver = useCallback(async () => {
    if (!repo || !openPath) return
    setConflictBusy(true)
    const fresh = await readFile(repo.owner, repo.name, openPath)
    setConflictBusy(false)
    if (!fresh.ok) {
      toast.error(fresh.error.message)
      return
    }
    setText(fresh.data.content)
    setBaseline(fresh.data.content)
    setLoadedSha(fresh.data.sha)
    setConflictOpen(false)
    clearDraft(docId)
  }, [repo, openPath, docId])

  const openHistory = useCallback(async () => {
    if (!repo || !openPath) return
    setHistoryOpen(true)
    setCommits(null)
    setHistoryError(null)
    setSelectedSha(null)
    setVersionContent(null)
    const res = await listFileCommits(repo.owner, repo.name, openPath)
    if (res.ok) setCommits(res.data)
    else setHistoryError(res.error.message)
  }, [repo, openPath])

  const selectVersion = useCallback(
    async (sha: string) => {
      if (!repo || !openPath) return
      setSelectedSha(sha)
      setVersionLoading(true)
      setVersionContent(null)
      const res = await readFileAtRef(repo.owner, repo.name, openPath, sha)
      setVersionLoading(false)
      if (res.ok) setVersionContent(res.data)
      else setHistoryError(res.error.message)
    },
    [repo, openPath],
  )

  const onRecover = useCallback(() => {
    if (versionContent === null) return
    setText(versionContent)
    setHistoryOpen(false)
    toast.info('Version loaded into working tree (unsaved)')
  }, [versionContent])

  const onFork = useCallback(() => {
    if (versionContent === null || !repo) return
    const content = versionContent
    setHistoryOpen(false)
    openPrompt({
      title: 'Create new diagram from this version',
      description: 'Save this version’s content as a separate new file.',
      label: 'New file path',
      defaultValue: 'diagrams/copy.mmd',
      submitLabel: 'Start editing',
      validate: validatePath,
      onSubmit: (path) => {
        setPromptOpen(false)
        setOpenPath(path)
        setLoadedSha(null)
        setBaseline('')
        setText(content)
      },
    })
  }, [versionContent, repo, openPrompt])

  const onThemeChange = useCallback((id: string) => updateConfig({ themeId: id }), [updateConfig])
  const canSave = !!repo && dirty && text.trim().length > 0 && !saving
  const showSidebar = githubEnabled && !!repo && sidebarOpen

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex flex-none items-center justify-between gap-4 border-b bg-card px-4 py-2">
        <div className="flex items-center gap-2">
          {githubEnabled && repo ? (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setSidebarOpen((v) => !v)}
              title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            >
              <PanelLeft />
            </Button>
          ) : null}
          <span className="text-lg text-primary">◇</span>
          <span className="text-[15px] font-semibold">keep-mermaid</span>
          {githubEnabled ? (
            <Button
              size="sm"
              variant="outline"
              className="ml-1 rounded-full"
              onClick={() => setRepoPickerOpen(true)}
            >
              <FolderGit2 />
              {repo ? `${repo.owner}/${repo.name}` : 'Connect repo'}
            </Button>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {githubEnabled ? (
            <>
              <span className="text-xs text-muted-foreground">
                {dirty ? '● Unsaved' : 'Saved'}
              </span>
              <Button size="sm" onClick={onSave} disabled={!canSave}>
                <Save /> {saving ? 'Saving…' : 'Save'}
              </Button>
              {openPath && repo ? (
                <Button size="sm" variant="ghost" onClick={openHistory}>
                  <History /> History
                </Button>
              ) : null}
              <Separator orientation="vertical" className="h-6" />
            </>
          ) : null}
          <ThemeSelect value={config.themeId} onChange={onThemeChange} loading={loading} />
          <ExportMenu
            text={debouncedText}
            colors={colors}
            baseName={baseName}
            includeBackground={config.bakeThemeOnExport}
            onToggleBackground={(v) => updateConfig({ bakeThemeOnExport: v })}
          />
          <Separator orientation="vertical" className="h-6" />
          <AuthButton user={user} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {showSidebar ? (
          <aside className="flex w-64 flex-none flex-col overflow-hidden border-r bg-sidebar">
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="truncate text-sm font-medium">{repo?.name}</span>
              <Button size="icon-xs" variant="ghost" onClick={newDiagram} title="New diagram">
                <Plus />
              </Button>
            </div>
            <Separator />
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {tree?.truncated ? (
                <p className="mb-2 rounded-md bg-muted p-2 text-xs text-muted-foreground">
                  ⚠ Large repo; some files may be hidden.
                </p>
              ) : null}
              {treeError ? (
                <p className="p-2 text-sm text-destructive">{treeError}</p>
              ) : tree === null ? (
                <p className="p-2 text-sm text-muted-foreground">Loading files…</p>
              ) : (
                <FileTree nodes={tree.tree} activePath={openPath} onOpenFile={openFile} />
              )}
            </div>
          </aside>
        ) : null}

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-none flex-wrap items-center gap-1.5 border-b px-3 py-2 text-xs text-muted-foreground">
            {githubEnabled && repo ? (
              <>
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setRepoPickerOpen(true)}
                >
                  {repo.owner}/{repo.name}
                </button>
                <ChevronRight className="size-3" />
                <span>{openPath ?? 'untitled (unsaved local draft)'}</span>
              </>
            ) : githubEnabled ? (
              <span>Connect a repository to browse and commit your diagrams.</span>
            ) : (
              <span>Local mode — edits stay in your browser (localStorage).</span>
            )}
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)]">
            <section className="min-h-0 overflow-auto" aria-label="Editor">
              <Editor value={text} onChange={setText} dark={dark} />
            </section>
            <div className="bg-border" role="separator" aria-orientation="vertical" />
            <section className="min-h-0 overflow-auto" aria-label="Preview">
              <Preview text={debouncedText} colors={colors} />
            </section>
          </div>
        </main>
      </div>

      {githubEnabled ? (
        <RepoPicker
          open={repoPickerOpen}
          onOpenChange={setRepoPickerOpen}
          onSelect={onSelectRepo}
        />
      ) : null}

      {openPath ? (
        <ConflictModal
          open={conflictOpen}
          onOpenChange={setConflictOpen}
          path={openPath}
          busy={conflictBusy}
          onOverwrite={onOverwrite}
          onStartOver={onStartOver}
        />
      ) : null}

      {prompt ? (
        <PromptModal open={promptOpen} onOpenChange={setPromptOpen} {...prompt} />
      ) : null}

      {openPath ? (
        <HistoryPanel
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          path={openPath}
          commits={commits}
          error={historyError}
          selectedSha={selectedSha}
          versionContent={versionContent}
          versionLoading={versionLoading}
          colors={colors}
          onSelect={selectVersion}
          onRecover={onRecover}
          onFork={onFork}
        />
      ) : null}
    </div>
  )
}

function validatePath(value: string): string | null {
  if (!value) return 'Enter a file path.'
  if (value.startsWith('/') || value.includes('..')) return 'Use a repo-relative path.'
  if (!isDiagramFile(value)) return 'Use a .md, .mmd, or .mermaid extension.'
  return null
}
