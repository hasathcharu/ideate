'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  FolderGit2,
  History,
  PanelLeft,
  Plus,
  RefreshCw,
  Save,
  Settings2,
} from 'lucide-react'
import { toast } from 'sonner'
import Editor from './Editor'
import Preview from './Preview'
import ExportMenu from './ExportMenu'
import AuthButton from './AuthButton'
import RepoPicker from './RepoPicker'
import FileTree from './FileTree'
import ConflictModal from './ConflictModal'
import DeleteModal from './DeleteModal'
import PromptModal, { type PromptModalProps } from './PromptModal'
import HistoryPanel from './HistoryPanel'
import ConfigModal from './ConfigModal'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DEFAULT_LAYOUT, LAYOUT_ENGINES } from '@/lib/mermaid'
import {
  parseMermaidConfig,
  applyThemeToSite,
  layoutFromConfig,
  setLayoutInYaml,
  type MermaidUserConfig,
} from '@/lib/mermaidConfig'
import { useDebouncedValue } from '@/lib/hooks'
import {
  loadConfig,
  saveConfig,
  loadDraft,
  saveDraft,
  clearDraft,
  docIdForFile,
  SCRATCH_DOC_ID,
} from '@/lib/storage'
import { APP_NAME } from '@/lib/config'
import { buildTree, collectFilePaths, isDiagramFile } from '@/lib/tree'
import { cn } from '@/lib/utils'
import {
  listTree,
  readFile,
  readFileAtRef,
  listFileCommits,
  commitFile,
  deletePaths,
  renameFile,
  type TreeResult,
} from '@/app/actions/github'
import type { AppConfig, FileCommit, Repo, SessionUser, TreeNode } from '@/lib/types'

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
    exportBackground: true,
    splitRatio: 0.5,
    mermaidConfig: '',
  })
  const [hydrated, setHydrated] = useState(false)
  const [isMac, setIsMac] = useState(false)

  // Live editor/preview split ratio (persisted to config on drag end).
  const [editorRatio, setEditorRatio] = useState(0.5)
  const paneRowRef = useRef<HTMLDivElement>(null)

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

  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [prompt, setPrompt] = useState<PromptSpec | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)

  const [configOpen, setConfigOpen] = useState(false)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [commits, setCommits] = useState<FileCommit[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [versionContent, setVersionContent] = useState<string | null>(null)
  const [versionLoading, setVersionLoading] = useState(false)

  const debouncedText = useDebouncedValue(text, 350)

  // Parse the user's YAML config. The memo keeps a stable object reference until
  // the raw text changes, so it's safe to feed into the Preview render effect's
  // deps. `appliedConfig` holds the last *valid* parse — a half-typed config
  // (parse error) leaves the previous theme in place rather than blanking it.
  const parsedConfig = useMemo(() => parseMermaidConfig(config.mermaidConfig), [config.mermaidConfig])
  const [appliedConfig, setAppliedConfig] = useState<MermaidUserConfig | null>(null)
  useEffect(() => {
    if (parsedConfig.error) return
    setAppliedConfig(parsedConfig.config)
    // themeVariables recolor the whole app chrome (empty config resets it).
    applyThemeToSite(parsedConfig.config)
  }, [parsedConfig])

  // The layout dropdown reflects — and writes back into — the YAML config, which
  // is the single source of truth. Selecting an engine rewrites the `layout` key
  // (see the Select's onValueChange, which calls setLayoutInYaml).
  const layoutValues = useMemo(() => LAYOUT_ENGINES.map((e) => e.value), [])
  const currentLayout = layoutFromConfig(appliedConfig, layoutValues, DEFAULT_LAYOUT)

  const repo = githubEnabled ? config.repo : null
  const dirty = text !== baseline
  const docId =
    repo && openPath ? docIdForFile(repo.owner, repo.name, openPath) : SCRATCH_DOC_ID
  // Export/download file name: the open file's name (folder + extension stripped).
  // Falls back to "diagram" only when nothing is open (local mode / fresh scratch).
  const baseName =
    (openPath ? (openPath.split('/').pop() ?? '').replace(/\.[^./]+$/, '') : '') || 'diagram'

  // A just-created file has no sha and isn't in the fetched tree yet; splice its
  // path in so it shows in the sidebar (flagged unsaved) before the first commit.
  const pendingPath = repo && openPath && loadedSha === null ? openPath : null
  const dirtyPath = dirty && openPath ? openPath : null
  const displayNodes = useMemo(() => {
    const base = tree?.tree ?? []
    if (!pendingPath) return base
    const paths = base.flatMap(collectFilePaths)
    if (!paths.includes(pendingPath)) paths.push(pendingPath)
    return buildTree(paths)
  }, [tree, pendingPath])

  const refreshTree = useCallback(async (target: { owner: string; name: string }) => {
    setTree(null)
    setTreeError(null)
    const res = await listTree(target.owner, target.name)
    if (res.ok) {
      setTree(res.data)
      return res.data
    }
    setTreeError(res.error.message)
    return null
  }, [])

  // Editor/canvas state for a freshly-opened repo: an empty repo (no diagram
  // files yet) gets a starter example to edit; a repo that already has files
  // opens blank so the user picks one from the tree.
  const showRepoStartState = useCallback((treeData: TreeResult) => {
    const hasFiles = treeData.tree.flatMap(collectFilePaths).length > 0
    setOpenPath(null)
    setLoadedSha(null)
    const content = hasFiles ? '' : SAMPLE
    setText(content)
    setBaseline(content)
  }, [])

  useEffect(() => {
    const stored = loadConfig()
    setConfig(stored)
    setEditorRatio(stored.splitRatio)
    setHydrated(true)

    // A non-empty scratch draft is unsaved working-copy work — restore it across
    // reloads rather than clobbering it with the start state.
    const draft = loadDraft(SCRATCH_DOC_ID)
    const restorable = draft && draft.content.trim().length > 0 ? draft.content : null

    if (githubEnabled && stored.repo) {
      void refreshTree(stored.repo).then((data) => {
        if (restorable !== null) {
          setText(restorable)
          setBaseline('')
        } else if (data) {
          showRepoStartState(data)
        }
      })
    } else if (restorable !== null && restorable !== SAMPLE) {
      setText(restorable)
      setBaseline(SAMPLE)
    }
  }, [githubEnabled, refreshTree, showRepoStartState])

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

  const MIN_RATIO = 0.2
  const MAX_RATIO = 0.8

  const startDividerDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const row = paneRowRef.current
      if (!row) return
      const onMove = (ev: PointerEvent) => {
        const rect = row.getBoundingClientRect()
        if (rect.width === 0) return
        const raw = (ev.clientX - rect.left) / rect.width
        setEditorRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, raw)))
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setEditorRatio((r) => {
          updateConfig({ splitRatio: r })
          return r
        })
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [updateConfig],
  )

  const onDividerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 0.1 : 0.02
      let delta = 0
      if (e.key === 'ArrowLeft') delta = -step
      else if (e.key === 'ArrowRight') delta = step
      else return
      e.preventDefault()
      setEditorRatio((r) => {
        const next = Math.min(MAX_RATIO, Math.max(MIN_RATIO, r + delta))
        updateConfig({ splitRatio: next })
        return next
      })
    },
    [updateConfig],
  )

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
      void refreshTree({ owner: r.owner, name: r.name }).then((data) => {
        if (data) showRepoStartState(data)
      })
    },
    [updateConfig, refreshTree, showRepoStartState],
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

  const newDiagram = useCallback(
    (dirPath?: string) => {
      if (!repo) {
        setOpenPath(null)
        setLoadedSha(null)
        setBaseline(NEW_TEMPLATE)
        setText(NEW_TEMPLATE)
        return
      }
      // Root-level create defaults to the repo root (no forced `diagrams/`);
      // a folder's "+" prefills that folder. Either way the user can type any
      // repo-relative path.
      const defaultValue = dirPath ? `${dirPath}/untitled.mmd` : 'untitled.mmd'
      openPrompt({
        title: 'New diagram',
        description: 'Create a new diagram file on main.',
        label: 'File path',
        defaultValue,
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
    },
    [repo, openPrompt],
  )

  const requestRename = useCallback(
    (node: TreeNode) => {
      if (!repo || node.type !== 'file') return
      openPrompt({
        title: 'Rename file',
        description: 'Move or rename this file on main. Git history is preserved as a rename.',
        label: 'New path',
        defaultValue: node.path,
        submitLabel: 'Rename',
        validate: validatePath,
        onSubmit: async (newPath) => {
          if (newPath === node.path) {
            setPromptOpen(false)
            return
          }
          const res = await renameFile(repo.owner, repo.name, node.path, newPath)
          if (!res.ok) {
            toast.error(res.error.message)
            return
          }
          setPromptOpen(false)
          // Carry any uncommitted draft over to the new path.
          const oldId = docIdForFile(repo.owner, repo.name, node.path)
          const newId = docIdForFile(repo.owner, repo.name, newPath)
          const draft = loadDraft(oldId)
          if (draft) saveDraft(newId, draft.content)
          clearDraft(oldId)
          if (openPath === node.path) {
            setOpenPath(newPath)
            setLoadedSha(res.data.sha)
          }
          toast.success(`Renamed to ${newPath}`)
          void refreshTree(repo)
        },
      })
    },
    [repo, openPrompt, openPath, refreshTree],
  )

  // Reset the editor to a fresh scratch doc — used when the file being edited is
  // deleted out from under it. Baseline is left empty (not equal to the text) so
  // the doc reads as unsaved and Save is enabled, prompting for a new path.
  const detachEditor = useCallback(() => {
    setOpenPath((prev) => {
      if (prev) clearDraft(docId)
      return null
    })
    setLoadedSha(null)
    setBaseline('')
    setText(NEW_TEMPLATE)
  }, [docId])

  const requestDelete = useCallback((node: TreeNode) => {
    setDeleteTarget(node)
    setDeleteOpen(true)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!repo || !deleteTarget) return
    const paths = collectFilePaths(deleteTarget)
    const affectsOpen = !!openPath && paths.includes(openPath)
    // A never-committed file (the pending new one) only exists locally — there is
    // nothing on GitHub to remove, so skip the API for it.
    const committed = paths.filter((p) => p !== pendingPath)
    if (committed.length === 0) {
      if (affectsOpen) detachEditor()
      setDeleteOpen(false)
      setDeleteTarget(null)
      return
    }
    setDeleteBusy(true)
    const res = await deletePaths(repo.owner, repo.name, committed)
    setDeleteBusy(false)
    if (!res.ok) {
      toast.error(res.error.message)
      return
    }
    toast.success(
      res.data.deleted === 1
        ? `Deleted ${committed[0]}`
        : `Deleted ${res.data.deleted} files`,
    )
    setDeleteOpen(false)
    setDeleteTarget(null)
    if (affectsOpen) detachEditor()
    void refreshTree(repo)
  }, [repo, deleteTarget, pendingPath, openPath, detachEditor, refreshTree])

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
        defaultValue: 'untitled.mmd',
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

  // Detect the platform for the correct modifier label (⌘ vs Ctrl).
  useEffect(() => {
    setIsMac(/mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent))
  }, [])

  // Keyboard shortcuts (only when GitHub repo features are active): ⌘/Ctrl+S
  // saves; ⌘/Ctrl+Alt+N starts a new diagram. New-diagram uses Alt because
  // browsers reserve plain ⌘/Ctrl+N (new window) and won't let a page cancel it.
  // `e.code` (physical key) is used so macOS Option+N (a dead key) still matches.
  useEffect(() => {
    if (!githubEnabled) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.code === 'KeyS' && !e.altKey) {
        e.preventDefault()
        onSave()
      } else if (e.code === 'KeyN' && e.altKey) {
        e.preventDefault()
        newDiagram()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [githubEnabled, onSave, newDiagram])

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

  const selectVersion = useCallback(
    async (commit: FileCommit) => {
      if (!repo) return
      setSelectedSha(commit.sha)
      setVersionLoading(true)
      setVersionContent(null)
      // Use the path the file had at that commit (may differ across renames).
      const res = await readFileAtRef(repo.owner, repo.name, commit.path, commit.sha)
      setVersionLoading(false)
      if (res.ok) setVersionContent(res.data)
      else setHistoryError(res.error.message)
    },
    [repo],
  )

  const openHistory = useCallback(async () => {
    if (!repo || !openPath) return
    setHistoryOpen(true)
    setCommits(null)
    setHistoryError(null)
    setSelectedSha(null)
    setVersionContent(null)
    const res = await listFileCommits(repo.owner, repo.name, openPath)
    if (res.ok) {
      setCommits(res.data)
      // Preselect the latest version (commits are newest-first).
      if (res.data[0]) void selectVersion(res.data[0])
    } else {
      setHistoryError(res.error.message)
    }
  }, [repo, openPath, selectVersion])

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
      defaultValue: 'copy.mmd',
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

  const canSave = !!repo && dirty && text.trim().length > 0 && !saving
  const showSidebar = githubEnabled && !!repo && sidebarOpen
  const saveHint = isMac ? '⌘ S' : 'Ctrl + S'
  const newHint = isMac ? '⌥ ⌘ N' : 'Ctrl + Alt + N'

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
          <span className="text-[15px] font-semibold">{APP_NAME}</span>
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
              <Button size="sm" onClick={onSave} disabled={!canSave} title={`Save (${saveHint})`}>
                <Save /> {saving ? 'Saving…' : 'Save'}
                <kbd className="ml-1 rounded border border-current/30 px-1 text-[10px] leading-relaxed font-medium opacity-70">
                  {saveHint}
                </kbd>
              </Button>
              {openPath && repo ? (
                <Button size="sm" variant="ghost" onClick={openHistory}>
                  <History /> History
                </Button>
              ) : null}
              <Separator orientation="vertical" className="h-6" />
            </>
          ) : null}
          <ExportMenu
            text={debouncedText}
            baseName={baseName}
            includeBackground={config.exportBackground}
            onToggleBackground={(v) => updateConfig({ exportBackground: v })}
            config={appliedConfig}
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
              <div className="flex items-center gap-0.5">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => repo && void refreshTree(repo)}
                  disabled={!repo || tree === null}
                  title="Refresh files"
                >
                  <RefreshCw className={cn(tree === null && 'animate-spin')} />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => newDiagram()}
                  title={`New diagram at root (${newHint})`}
                >
                  <Plus />
                </Button>
              </div>
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
                <FileTree
                  nodes={displayNodes}
                  activePath={openPath}
                  dirtyPath={dirtyPath}
                  onOpenFile={openFile}
                  onDelete={requestDelete}
                  onNewFile={(dir) => newDiagram(dir)}
                  onRename={requestRename}
                />
              )}
            </div>
            <Separator />
            <div className="flex-none px-3 py-2 text-xs text-muted-foreground">
              Made by{' '}
              <a
                href="https://hasathcharu.com"
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-foreground hover:text-primary hover:underline"
              >
                Hasathcharu
              </a>
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
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-muted-foreground">Layout</span>
              <Select
                value={currentLayout}
                onValueChange={(v) =>
                  updateConfig({ mermaidConfig: setLayoutInYaml(config.mermaidConfig, v) })
                }
              >
                <SelectTrigger size="sm" className="h-7" aria-label="Layout engine">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {LAYOUT_ENGINES.map((engine) => (
                    <SelectItem key={engine.value} value={engine.value}>
                      {engine.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="icon-sm"
                variant="ghost"
                className="size-7"
                onClick={() => setConfigOpen(true)}
                aria-label="Diagram configuration"
                title="Diagram configuration"
              >
                <Settings2 />
              </Button>
            </div>
          </div>

          <div
            ref={paneRowRef}
            className="grid min-h-0 flex-1"
            style={{
              gridTemplateColumns: `minmax(0,${editorRatio}fr) 6px minmax(0,${1 - editorRatio}fr)`,
            }}
          >
            <section className="min-h-0 overflow-auto" aria-label="Editor">
              <Editor value={text} onChange={setText} dark={false} />
            </section>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize editor and preview"
              aria-valuemin={20}
              aria-valuemax={80}
              aria-valuenow={Math.round(editorRatio * 100)}
              tabIndex={0}
              onPointerDown={startDividerDrag}
              onKeyDown={onDividerKeyDown}
              className="group flex cursor-col-resize touch-none items-center justify-center bg-border transition-colors hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none"
            >
              <div className="h-8 w-0.5 rounded-full bg-muted-foreground/40 transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
            </div>
            <section className="min-h-0 overflow-auto" aria-label="Preview">
              <Preview
                text={debouncedText}
                config={appliedConfig}
              />
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

      <ConfigModal
        open={configOpen}
        onOpenChange={setConfigOpen}
        value={config.mermaidConfig}
        onChange={(v) => updateConfig({ mermaidConfig: v })}
        error={parsedConfig.error}
      />

      <DeleteModal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        target={deleteTarget}
        fileCount={deleteTarget ? collectFilePaths(deleteTarget).length : 0}
        busy={deleteBusy}
        onConfirm={confirmDelete}
      />

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
