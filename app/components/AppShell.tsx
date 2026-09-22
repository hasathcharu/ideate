'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { PromptModalProps } from './PromptModal'
import { useHistoryController } from './useHistoryController'
import { useAgentLinkController } from './useAgentLinkController'
import {
  CUSTOM_THEME,
  NONE_THEME,
  useAppearanceController,
} from './useAppearanceController'
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useResizableLayout,
} from './useResizableLayout'
import AppDialogs from './AppDialogs'
import AppHeader from './AppHeader'
import AppLayout from './AppLayout'
import DocumentSurface from './DocumentSurface'
import DocumentToolbar from './DocumentToolbar'
import WorkspaceSidebar from './WorkspaceSidebar'
import { useWorkspaceTree } from './useWorkspaceTree'
import { ensureExcalidrawFonts } from '@/lib/excalidrawFonts'
import { useDebouncedValue, useIsMobile } from '@/lib/hooks'
import { canConsumeScratchDraft, draftBaseFor, draftNeedsReconciliation, needsDraft } from '@/lib/draftLifecycle'
import { saveLocalBatch } from '@/lib/localBatch'
import { handleExpiredSession } from '@/lib/sessionExpiry'
import { RequestGate, WorkspaceStore, documentKey, workspaceKey, type DocumentIdentity, type WorkspaceIdentity } from '@/lib/workspaceStore'
import {
  loadAgentLink,
  loadConfig,
  openDocumentStorage,
  saveAgentLink,
  saveConfig,
  clearDraft,
  readDraftResult,
  writeDraftResult,
  createDraftResult,
  docIdForFile,
  docIdForLocalFile,
  scratchDocIdFor,
  listDraftPathsResult,
  listLocalDraftPathsResult,
  listLocalFilesResult,
  readLocalFileResult,
  saveLocalFileAndClearDraft,
  moveLocalFileAndDraft,
  deleteLocalFilesAndDrafts,
} from '@/lib/storage'
import { APP_NAME, DEFAULT_MCP_ORIGIN } from '@/lib/config'
import {
  buildTree,
  collectFilePaths,
  fileExtension,
  fileKind,
  isDiagramFile,
  DIAGRAM_EXTENSIONS_LABEL,
  EXCALIDRAW_EXTENSION,
  type FileKind,
} from '@/lib/tree'
import { EMPTY_SCENE, scenesEqual } from '@/lib/excalidraw'
import {
  checkSession,
  commitFiles,
  listTree,
  readFile,
  commitFile,
  deletePaths,
  renameFile,
  createBranch,
  type FileWrite,
  type TreeResult,
} from '@/app/actions/github'
import type { AppConfig, Repo, RepoRef, SessionUser, TreeNode } from '@/lib/types'

export interface AppShellProps {
  user: SessionUser | null
  mode: 'local' | 'github'
}

const SAMPLE = `flowchart TD
  A[Working copy in IndexedDB] -->|Save = commit| B(GitHub repo)
  B --> C{Conflict?}
  C -->|No| D[Committed on your branch]
  C -->|Yes| E[Refetch sha, commit on top]
  E --> D
`

// Starter diagram for a new mermaid file. A worked example rather than a bare
// `A --> B`: the fastest way to learn the syntax is to edit something that
// already uses branches, labelled edges and a few node shapes.
const NEW_TEMPLATE = `flowchart TD
  A[Idea] --> B{How to capture it?}
  B -->|Describe it| C[Mermaid diagram]
  B -->|Draw it| D[Excalidraw canvas]
  C --> E[Commit to GitHub]
  D --> E
`

// Starter markdown document. Deliberately a tour of *markdown* — headings,
// lists, a checklist, a table, a quote, code — since the diagram kinds already
// cover diagrams. The mermaid capability gets a one-line prose mention instead
// of a worked fence, so the sample stays a markdown sample.
const NEW_MARKDOWN_TEMPLATE = [
  '# Untitled',
  '',
  'Write here — the rendered document appears on the right. A fenced `mermaid`',
  'code block renders inline as a themed diagram.',
  '',
  '## Notes',
  '',
  '- A bullet point',
  '- Another one',
  '  - And a nested detail',
  '',
  '## Checklist',
  '',
  '- [x] Something already done',
  '- [ ] Something still to do',
  '',
  '## Reference',
  '',
  '| Option | Meaning |',
  '| --- | --- |',
  '| First | Does one thing |',
  '| Second | Does another |',
  '',
  '> Use a quote for an aside.',
  '',
  'Inline `code`, a [link](https://example.com), and a block:',
  '',
  '```ts',
  'export const answer = 42',
  '```',
  '',
].join('\n')

/** Starter content for a newly created file, by kind. A new Excalidraw file is a
 *  blank scene rather than a sample drawing — there's no equivalent of "example
 *  syntax to edit" on a canvas. */
function templateFor(kind: FileKind): string {
  switch (kind) {
    case 'excalidraw':
      return EMPTY_SCENE
    case 'markdown':
      return NEW_MARKDOWN_TEMPLATE
    case 'mermaid':
      return NEW_TEMPLATE
  }
}

/** The extension a newly created file of this kind gets. The kind is chosen
 *  before the name is typed (in `NewFileMenu`), so the extension is fixed by then
 *  — the create prompt shows it as an uneditable suffix. */
function extensionFor(kind: FileKind): string {
  switch (kind) {
    case 'excalidraw':
      return EXCALIDRAW_EXTENSION
    case 'markdown':
      return '.md'
    case 'mermaid':
      return '.mmd'
  }
}

/** The filename prefilled in a save/create prompt, so the extension always
 *  matches the content's kind. */
function defaultFileName(kind: FileKind, base: string): string {
  return `${base}${extensionFor(kind)}`
}

/** Whether two versions of the same document differ. */
function contentDiffers(a: string, b: string, kind: FileKind): boolean {
  return kind === 'excalidraw' ? !scenesEqual(a, b) : a !== b
}

/** What `loadedSha` holds for a saved *local* file. */
const LOCAL_SAVED = 'local'

/** A new Set with `paths` removed — used to clear dirty-tracking on delete/commit. */
function withoutPaths(set: ReadonlySet<string>, paths: string[]): ReadonlySet<string> {
  if (!paths.some((p) => set.has(p))) return set
  const next = new Set(set)
  for (const p of paths) next.delete(p)
  return next
}

/** A new Set with `path` added — the counterpart of `withoutPaths`. */
function withPath(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  if (set.has(path)) return set
  const next = new Set(set)
  next.add(path)
  return next
}

/** The fetched tree with `path` spliced in as a committed file. */
function treeWithPath(tree: TreeResult, path: string): TreeResult {
  const paths = tree.tree.flatMap(collectFilePaths)
  if (paths.includes(path)) return tree
  return { ...tree, tree: buildTree([...paths, path]) }
}

type PromptSpec = Pick<
  PromptModalProps,
  | 'title'
  | 'description'
  | 'label'
  | 'defaultValue'
  | 'prefix'
  | 'suffix'
  | 'selection'
  | 'submitLabel'
  | 'validate'
  | 'onSubmit'
>

export default function AppShell({ user, mode }: AppShellProps) {
  const githubEnabled = mode === 'github' && !!user

  const [config, setConfig] = useState<AppConfig>({
    repo: null,
    exportBackground: 'white',
    pngScale: { mode: 'auto' },
    splitRatio: 0.5,
    sidebarWidth: 256,
    wrapLines: false,
    minimap: true,
    scratchKind: 'mermaid',
    mcpOrigin: null,
    mermaidConfig: '',
  })
  const [hydrated, setHydrated] = useState(false)
  const configRef = useRef(config)
  const workspaceStoreRef = useRef<WorkspaceStore | null>(null)
  if (!workspaceStoreRef.current) workspaceStoreRef.current = new WorkspaceStore()
  const workspaceStore = workspaceStoreRef.current
  const currentWorkspace = useCallback((): WorkspaceIdentity => {
    const selected = mode === 'github' ? configRef.current.repo : null
    return selected
      ? { mode: 'github', owner: selected.owner, repo: selected.name, branch: selected.branch }
      : { mode: 'local' }
  }, [mode])
  const identityFor = useCallback((path: string | null, scratchKind?: FileKind): DocumentIdentity => ({
    // Scratch drafts are global per kind in the current storage contract.
    workspace: path ? currentWorkspace() : { mode: 'local' },
    path, kind: path ? fileKind(path) : (scratchKind ?? configRef.current.scratchKind),
  }), [currentWorkspace])
  const workspaceSelectionRef = useRef(workspaceKey(currentWorkspace()))
  const updateConfig = useCallback((patch: Partial<AppConfig>) => {
    configRef.current = { ...configRef.current, ...patch }
    workspaceSelectionRef.current = workspaceKey(currentWorkspace())
    setConfig((prev) => {
      const next = { ...prev, ...patch }
      saveConfig(next)
      return next
    })
  }, [currentWorkspace])

  /** Agent Link, scoped to *this tab* rather than to the origin — see `loadAgentLink`. */
  const [agentLinkOn, setAgentLinkOn] = useState(false)
  const enableAgentLink = useCallback((enabled: boolean) => {
    setAgentLinkOn(enabled)
    saveAgentLink(enabled)
  }, [])
  const [isMac, setIsMac] = useState(false)

  // Warn on small screens once per load — the layout needs room for the editor
  // and preview side by side, but the user can dismiss and continue anyway.
  const isMobile = useIsMobile()
  const [mobileWarningOpen, setMobileWarningOpen] = useState(false)
  const [mobileWarningDismissed, setMobileWarningDismissed] = useState(false)
  useEffect(() => {
    if (isMobile && !mobileWarningDismissed) setMobileWarningOpen(true)
  }, [isMobile, mobileWarningDismissed])

  // Excalidraw's scene fonts, registered on page load rather than when a canvas mounts.
  useEffect(() => {
    void ensureExcalidrawFonts()
  }, [])

  const {
    editorRatio,
    setEditorRatio,
    sidebarWidth,
    setSidebarWidth,
    paneRowRef,
    startDividerDrag,
    onDividerKeyDown,
    startSidebarDrag,
    onSidebarDividerKeyDown,
  } = useResizableLayout(updateConfig)

  const [text, setTextState] = useState(SAMPLE)
  const liveTextRef = useRef(text)
  const workingRevisionRef = useRef(0)
  const openPathRef = useRef<string | null>(null)
  const openRequestRef = useRef(0)
  const activeIdentityRef = useRef<DocumentIdentity>(identityFor(null))
  const setText = useCallback((next: string) => {
    liveTextRef.current = next
    workingRevisionRef.current += 1
    workspaceStore.edit(activeIdentityRef.current, next)
    setTextState(next)
  }, [workspaceStore])
  const [baseline, setBaseline] = useState(SAMPLE)
  const [openPath, setOpenPathState] = useState<string | null>(null)
  const setOpenPath = useCallback((next: string | null) => {
    openRequestRef.current += 1
    openPathRef.current = next
    activeIdentityRef.current = identityFor(next)
    workspaceStore.activate(documentKey(activeIdentityRef.current))
    setOpenPathState(next)
  }, [identityFor, workspaceStore])
  const [loadedSha, setLoadedSha] = useState<string | null>(null)
  // Files opened by following a link inside a document, so there is a way back.
  // Only link navigation pushes: picking a file in the tree is a fresh start, not
  // a step in a trail, and a Back button that then jumped somewhere unrelated
  // would be worse than none.
  const [linkTrail, setLinkTrail] = useState<Array<{ path: string; scrollTop: number }>>([])
  const [markdownScrollTop, setMarkdownScrollTop] = useState(0)
  const clearLinkTrail = useCallback(() => setLinkTrail([]), [])

  const [tree, setTree] = useState<TreeResult | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  // Tracked separately from `tree === null` so a refresh can spin the button and
  // report failure without blanking a list that's still perfectly valid.
  const [treeLoading, setTreeLoading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const [saving, setSaving] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)
  const [conflictBusy, setConflictBusy] = useState(false)
  const [draftConflictKey, setDraftConflictKey] = useState<string | null>(null)
  const draftBasesRef = useRef(new globalThis.Map<string, import('@/lib/storage').DraftBaseRevision>())

  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [branchBusy, setBranchBusy] = useState(false)
  const [prompt, setPrompt] = useState<PromptSpec | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)
  const openPrompt = useCallback((spec: PromptSpec) => {
    setPrompt(spec)
    setPromptOpen(true)
  }, [])
  const [configOpen, setConfigOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  // Swaps the editor/preview split for a diff of the committed file against the
  // working copy. Sticky across file switches (like the wrap toggle), but only
  // *rendered* where there is a committed side to compare with — see `canDiff`.
  const [showDiff, setShowDiff] = useState(false)

  const {
    parsedConfig,
    appliedConfig,
    currentLayout,
    currentTheme,
    applyTheme,
    canvasTheme,
    canvasBackground,
    editorDark,
  } = useAppearanceController(config, updateConfig)

  const repo = githubEnabled ? config.repo : null

  /** Local mode: no GitHub, and IndexedDB holds the saved files as well as the drafts over them. */
  const localMode = !githubEnabled

  /** Whether there is a file workspace at all: a connected repo, or local mode.
   *  Signed in with no repo picked there is none, and the sidebar has nothing to
   *  show. */
  const hasWorkspace = localMode || !!repo

  /** Every saved local file, or null before the store has been read (which is one
   *  render, and is not the same as "no files" — see `savedPaths`). */
  const [localPaths, setLocalPaths] = useState<readonly string[] | null>(null)

  /** Re-read the local store. Called after every write to it, because it *is* the
   *  file system in local mode — there is nothing to fetch and nothing to be stale
   *  against. */
  const refreshLocalFiles = useCallback(async () => {
    const result = await listLocalFilesResult()
    if (result.status === 'ok') setLocalPaths(result.value)
    else toast.error('Could not list files in browser storage.')
  }, [])

  // Which editor the current document gets. For a repo file the extension decides; with nothing
  // open (local mode, or before picking a file) it's the user's scratch choice.
  const kind: FileKind = openPath ? fileKind(openPath) : config.scratchKind

  const dirty = needsDraft(contentDiffers(text, baseline, kind), openPath !== null && loadedSha === null)
  // Each scratch kind gets its own draft slot, so toggling between diagram,
  // document and canvas with nothing open parks the current work rather than
  // overwriting it with content the other surface can't read.
  const scratchDocId = scratchDocIdFor(config.scratchKind)

  /** The draft slot for a path in whichever store is backing this session. Every
   *  read and write of a draft goes through here, so the two stores can never end
   *  up sharing a slot. */
  const docIdForPath = useCallback(
    (path: string): string =>
      repo ? docIdForFile(repo.owner, repo.name, repo.branch, path) : docIdForLocalFile(path),
    [repo],
  )

  const docId = openPath && hasWorkspace ? docIdForPath(openPath) : scratchDocId

  const recoverHistoryVersion = useCallback((content: string) => {
    setText(content)
    toast.info('Version loaded into working tree (unsaved)')
  }, [setText])

  const forkHistoryVersion = useCallback((content: string) => {
    if (!repo) return
    openPrompt({
      title: 'Create new diagram from this version',
      description: 'Save this version’s content as a separate new file.',
      label: 'New file path',
      defaultValue: defaultFileName(kind, 'copy'),
      submitLabel: 'Start editing',
      validate: validatePathForKind(kind),
      onSubmit: (path) => {
        setPromptOpen(false)
        setOpenPath(path)
        setLoadedSha(null)
        setBaseline('')
        setText(content)
      },
    })
  }, [repo, kind, openPrompt, setOpenPath, setText])

  const history = useHistoryController({
    repo,
    openPath,
    workspaceIdentity: workspaceSelectionRef.current,
    workingContent: text,
    onRecover: recoverHistoryVersion,
    onFork: forkHistoryVersion,
  })
  const resetHistory = history.reset

  // The editor callback updates liveTextRef before React renders. Navigation can
  // therefore persist the outgoing document even in the same event as an edit.
  const activeDraftRef = useRef({ docId, baseline, kind, pending: openPath !== null && loadedSha === null,
    savedRevision: loadedSha })
  activeDraftRef.current = { docId, baseline, kind, pending: openPath !== null && loadedSha === null,
    savedRevision: loadedSha }
  const flushOutgoingDraft = useCallback(async (): Promise<boolean> => {
    const active = activeDraftRef.current
    const content = liveTextRef.current
    if (!needsDraft(contentDiffers(content, active.baseline, active.kind), active.pending)) return true
    const base = draftBasesRef.current.get(active.docId) ?? draftBaseFor(active.savedRevision)
    draftBasesRef.current.set(active.docId, base)
    const result = await writeDraftResult(active.docId, content, base)
    workspaceStore.markPersistence(documentKey(activeIdentityRef.current), result.ok ? 'dirty' : 'failed')
    if (result.ok) return true
    toast.error(`Could not preserve unsaved work in this browser (${result.reason}).`)
    return false
  }, [workspaceStore])

  // Keyed on the open document: edits within a file debounce, but switching files
  // takes effect at once so nothing downstream ever sees the outgoing file's text.
  const debouncedText = useDebouncedValue(text, 350, docId)
  // Export/download file name: the open file's name (folder + extension stripped).
  // Falls back to "diagram" only when nothing is open (local mode / fresh scratch).
  const baseName =
    (openPath ? (openPath.split('/').pop() ?? '').replace(/\.[^./]+$/, '') : '') || 'diagram'

  /**
   * Files that exist only in this browser: created here, never committed, so the fetched tree has
   * no entry for them and GitHub has nothing under the path.
   */
  const {
    setCreatedPaths,
    dirtyPaths,
    setDirtyPaths,
    savedPaths,
    pendingPaths,
    displayNodes,
    visibleNodes,
    visibleExpanded,
    fileFilter,
    setFileFilter,
    searching,
    toggleVisibleDir,
    repoFilePaths,
    resetExpandedPaths,
  } = useWorkspaceTree({
    localMode,
    localPaths,
    tree,
    hasWorkspace,
    openPath,
    loadedSha,
    openDocumentDirty: dirty,
    selectedWorkspaceKey: workspaceKey(currentWorkspace()),
    workspaceStore,
  })

  /** Fetch the tree and swap it in once it arrives. */
  const treeRequestRef = useRef(new RequestGate())
  const refreshTree = useCallback(async (target: RepoRef) => {
    const targetKey = workspaceKey({ mode: 'github', owner: target.owner, repo: target.name, branch: target.branch })
    const request = treeRequestRef.current.begin(targetKey)
    setTreeLoading(true)
    setTreeError(null)
    const res = await listTree(
      target.owner,
      target.name,
      target.branch,
      target.branch === target.defaultBranch,
    )
    if (!treeRequestRef.current.accepts(request, workspaceSelectionRef.current)) return null
    setTreeLoading(false)
    if (res.ok) {
      setTree(res.data)
      return res.data
    }
    if (handleExpiredSession(res.error)) return null
    // The connected repo is unreachable (uninstalled, access narrowed, renamed or deleted).
    if (res.error.kind === 'repo_unavailable') setRepoPickerOpen(true)
    // Set either way, so dismissing the picker leaves an explanation in the
    // sidebar instead of an inert empty pane.
    setTreeError(res.error.message)
    return null
  }, [])

  // Editor/canvas state for a freshly-opened repo: an empty repo (no diagram
  // files yet) gets a starter example to edit; a repo that already has files
  // opens blank so the user picks one from the tree.
  const showRepoStartState = useCallback(
    (treeData: TreeResult) => {
      const hasFiles = treeData.tree.flatMap(collectFilePaths).length > 0
      updateConfig({ scratchKind: 'mermaid' })
      setOpenPath(null)
      setLoadedSha(null)
      const content = hasFiles ? '' : SAMPLE
      setText(content)
      setBaseline(content)
      // This content is mermaid source, so the scratch surface has to be the text
      // editor — otherwise a leftover canvas choice would try to parse it as a scene.
    },
    [updateConfig, setOpenPath, setText],
  )

  // Invalidate everything scoped to the previously-selected repo/branch — called
  // synchronously before the new tree fetch even starts, so nothing from the old
  // repo (stale editor content, dirty markers, expanded folders) can linger if
  // that fetch is slow or fails.
  const resetForRepoSwitch = useCallback(() => {
    resetHistory()
    updateConfig({ scratchKind: 'mermaid' })
    setOpenPath(null)
    setLoadedSha(null)
    setLinkTrail([])
    setText('')
    setBaseline('')
    setDirtyPaths(new Set())
    setCreatedPaths(new Set())
    resetExpandedPaths()
    // The outgoing repo/branch's paths are meaningless now, so this is one of the
    // few places the list *should* go back to a loading state.
    setTree(null)
    setTreeError(null)
  }, [resetHistory, resetExpandedPaths, updateConfig, setOpenPath, setText, setCreatedPaths, setDirtyPaths])

  useEffect(() => {
    void (async () => {
    // `loginWithGitHub` redirects here with `?connect=1`, which marks this arrival as a fresh
    // sign-in: drop whatever repository was selected before so the user always picks one after
    // logging in (the auto-open effect below then shows the picker).
    const url = new URL(window.location.href)
    const freshLogin = githubEnabled && url.searchParams.get('connect') === '1'
    if (url.searchParams.has('connect')) {
      url.searchParams.delete('connect')
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }

    const storageReady = await openDocumentStorage()
    if (!storageReady.ok) {
      toast.error('Document storage is unavailable. Files and drafts have not been treated as empty.')
    }
    const loaded = loadConfig()
    const stored = freshLogin ? { ...loaded, repo: null } : loaded
    configRef.current = stored
    workspaceSelectionRef.current = workspaceKey(currentWorkspace())
    activeIdentityRef.current = identityFor(null, stored.scratchKind)
    const initialActivation = workspaceStore.activate(documentKey(activeIdentityRef.current))
    if (freshLogin) saveConfig(stored)
    setConfig(stored)
    setEditorRatio(stored.splitRatio)
    setSidebarWidth(stored.sidebarWidth)
    setAgentLinkOn(loadAgentLink())
    // The local store is the file system in local mode, so read it now rather than
    // leave `localPaths` null — every "does this file exist" question below waits on
    // it, the agent's included.
    if (!githubEnabled && storageReady.ok) {
      const local = await listLocalFilesResult()
      if (local.status === 'ok') setLocalPaths(local.value)
      else toast.error('Could not list files in browser storage.')
    }

    // A non-empty scratch draft is unsaved working-copy work — restore it across
    // reloads rather than clobbering it with the start state. Which slot to read
    // depends on the scratch surface the user last had open.
    const draft = storageReady.ok
      ? await readDraftResult(scratchDocIdFor(stored.scratchKind))
      : { status: 'unavailable' as const }
    const restorable = draft.status === 'ok' && draft.value.content.trim().length > 0
      ? draft.value.content : null

    if (githubEnabled && stored.repo) {
      if (restorable !== null) {
        setText(restorable)
        setBaseline('')
      }
      void refreshTree(stored.repo).then((data) => {
        if (workspaceStore.active().generation !== initialActivation) return
        if (restorable === null && data) showRepoStartState(data)
      })
    } else if (stored.scratchKind === 'excalidraw') {
      setText(restorable ?? EMPTY_SCENE)
      setBaseline(EMPTY_SCENE)
    } else if (stored.scratchKind === 'markdown') {
      setText(restorable ?? NEW_MARKDOWN_TEMPLATE)
      setBaseline(NEW_MARKDOWN_TEMPLATE)
    } else if (restorable !== null && restorable !== SAMPLE) {
      setText(restorable)
      setBaseline(SAMPLE)
    }
    setHydrated(true)
    })()
  }, [githubEnabled, refreshTree, showRepoStartState, setText, setEditorRatio, setSidebarWidth,
    currentWorkspace, identityFor, workspaceStore])

  /**
   * Recover never-saved files across a reload. Neither `openPath` nor `createdPaths` is persisted,
   * so after a refresh nothing remembers them — but their drafts are still in IndexedDB, and a
   * draft under a path the saved store doesn't have can only be a file created here and never
   * saved.
   */
  const recoveredFor = useRef<string | null>(null)
  useEffect(() => {
    if (!hasWorkspace || !savedPaths) return
    void (async () => {
    const key = repo ? docIdForFile(repo.owner, repo.name, repo.branch, '') : 'local'
    if (recoveredFor.current === key) return
    const committed = savedPaths
    const listing = await (repo
      ? listDraftPathsResult(repo.owner, repo.name, repo.branch)
      : listLocalDraftPathsResult())
    if (listing.status !== 'ok') {
      toast.error('Could not list unsaved drafts in browser storage.')
      return
    }
    recoveredFor.current = key
    const drafts = listing.value
    if (drafts.length === 0) return
    // A draft is only ever written while a document is dirty and is cleared the moment it isn't, so
    // a draft under this branch *is* a file with uncommitted edits — light its marker in the
    // sidebar.
    setDirtyPaths((prev) => {
      const next = new Set(prev)
      for (const path of drafts) next.add(path)
      return next
    })
    const orphans = drafts.filter((path) => !committed.has(path))
    if (orphans.length === 0) return
    setCreatedPaths((prev) => {
      const next = new Set(prev)
      for (const path of orphans) next.add(path)
      return next
    })
    })()
  }, [hasWorkspace, savedPaths, repo, setCreatedPaths, setDirtyPaths])

  /** Verify the GitHub session before the user relies on it. */
  const sessionChecked = useRef(false)
  useEffect(() => {
    if (!githubEnabled || sessionChecked.current) return
    sessionChecked.current = true
    void checkSession().then((res) => {
      if (!res.ok) handleExpiredSession(res.error)
    })
  }, [githubEnabled])

  // Signed in with no repository selected, the app can't read, commit or browse
  // anything — so lead with the picker instead of an inert editor and a hint in
  // the status bar. Fires once per mount (the ref), so dismissing it to poke at
  // the local scratch document doesn't immediately reopen it.
  const repoPickerAutoOpened = useRef(false)
  useEffect(() => {
    if (!hydrated || !githubEnabled || config.repo || repoPickerAutoOpened.current) return
    repoPickerAutoOpened.current = true
    setRepoPickerOpen(true)
  }, [hydrated, githubEnabled, config.repo])

  // Persist live content, independently of the preview debounce. A pending file
  // keeps its existence record even when its content is empty.
  useEffect(() => {
    if (!hydrated) return
    void (async () => {
    if (dirty) {
      const base = draftBasesRef.current.get(docId) ?? draftBaseFor(loadedSha)
      draftBasesRef.current.set(docId, base)
      const result = await writeDraftResult(docId, text, base)
      workspaceStore.markPersistence(documentKey(activeIdentityRef.current), result.ok ? 'dirty' : 'failed')
      if (!result.ok) toast.error(`Could not preserve unsaved work in this browser (${result.reason}).`)
    }
    else {
      const stored = await readDraftResult(docId)
      if (stored.status === 'ok') await clearDraft(docId)
    }
    })()
  }, [text, docId, hydrated, dirty, loadedSha, workspaceStore])

  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  /** Switch the scratch document between the text editor and the canvas. */
  const switchScratchKind = useCallback(
    async (nextKind: FileKind) => {
      if (openPath || nextKind === config.scratchKind) return
      if (!await flushOutgoingDraft()) return
      const parked = await readDraftResult(scratchDocIdFor(nextKind))
      if (parked.status === 'invalid' || parked.status === 'unavailable') {
        toast.error(`Could not open the parked ${nextKind} draft: ${parked.status}.`)
        return
      }
      const fresh = templateFor(nextKind)
      updateConfig({ scratchKind: nextKind })
      openRequestRef.current += 1
      activeIdentityRef.current = identityFor(null, nextKind)
      workspaceStore.activate(documentKey(activeIdentityRef.current))
      setText(parked.status === 'ok' ? parked.value.content : fresh)
      // Baseline is the pristine template, so a restored draft correctly reads as
      // unsaved work while a fresh switch reads as clean.
      setBaseline(fresh)
    },
    [openPath, config.scratchKind, flushOutgoingDraft, updateConfig, setText, identityFor, workspaceStore],
  )

  const onSelectRepo = useCallback(
    async (r: Repo) => {
      if (!await flushOutgoingDraft()) return
      const next: RepoRef = {
        owner: r.owner,
        name: r.name,
        defaultBranch: r.defaultBranch,
        branch: r.defaultBranch,
      }
      updateConfig({ repo: next })
      setRepoPickerOpen(false)
      resetForRepoSwitch()
      const activation = workspaceStore.active().generation
      void refreshTree(next).then((data) => {
        if (data && workspaceStore.active().generation === activation) showRepoStartState(data)
      })
    },
    [updateConfig, refreshTree, showRepoStartState, resetForRepoSwitch, flushOutgoingDraft, workspaceStore],
  )

  const onSelectBranch = useCallback(
    async (branch: string) => {
      if (!repo) return
      if (!await flushOutgoingDraft()) return
      const next: RepoRef = { ...repo, branch }
      updateConfig({ repo: next })
      setBranchPickerOpen(false)
      resetForRepoSwitch()
      const activation = workspaceStore.active().generation
      void refreshTree(next).then((data) => {
        if (data && workspaceStore.active().generation === activation) showRepoStartState(data)
      })
    },
    [repo, updateConfig, refreshTree, showRepoStartState, resetForRepoSwitch, flushOutgoingDraft, workspaceStore],
  )

  const onCreateBranch = useCallback(
    async (name: string) => {
      if (!repo) return
      setBranchBusy(true)
      const res = await createBranch(repo.owner, repo.name, name, repo.branch)
      setBranchBusy(false)
      if (!res.ok) {
        if (handleExpiredSession(res.error)) return
        toast.error(res.error.message)
        return
      }
      toast.success(`Created and switched to ${name}`)
      await onSelectBranch(name)
    },
    [repo, onSelectBranch],
  )

  /** The saved copy of `path`: the committed file on the branch, or the local file in IndexedDB. */
  const readSaved = useCallback(
    async (
      path: string,
    ): Promise<
      | { ok: true; content: string; sha: string }
      | { ok: false; message: string; expired: boolean }
    > => {
      if (!repo) {
        const file = await readLocalFileResult(path)
        if (file.status !== 'ok') {
          return { ok: false, message: `${path} is ${file.status} in this browser.`, expired: false }
        }
        return { ok: true, content: file.value.content, sha: LOCAL_SAVED }
      }
      const res = await readFile(repo.owner, repo.name, path, repo.branch)
      if (!res.ok) {
        return {
          ok: false,
          message: res.error.message,
          expired: handleExpiredSession(res.error),
        }
      }
      return { ok: true, content: res.data.content, sha: res.data.sha }
    },
    [repo],
  )

  const openFile = useCallback(
    async (path: string): Promise<boolean> => {
      if (!hasWorkspace) return false
      if (path === openPathRef.current) return true
      if (!await flushOutgoingDraft()) return false
      const request = ++openRequestRef.current
      const requestedWorkspace = workspaceSelectionRef.current
      const activation = workspaceStore.active().generation
      // A never-committed file has nothing on GitHub under its path, so reading it
      // would 404. Its draft *is* the file: reopen it exactly as it was created —
      // no sha, empty baseline, so it still reads as unsaved.
      if (pendingPaths.has(path)) {
        const draft = await readDraftResult(docIdForPath(path))
        if (draft.status !== 'ok') {
          toast.error(`Could not open ${path}: its unsaved draft is ${draft.status}.`)
          return false
        }
        draftBasesRef.current.set(docIdForPath(path), draft.value.baseRevision)
        setBaseline('')
        setLoadedSha(null)
        setOpenPath(path)
        setText(draft.value.content)
        workspaceStore.adopt(identityFor(path), draft.value.content, '', null, workspaceStore.active().generation)
        setDraftConflictKey(null)
        return true
      }
      const res = await readSaved(path)
      if (request !== openRequestRef.current || requestedWorkspace !== workspaceSelectionRef.current ||
          activation !== workspaceStore.active().generation) return false
      if (!res.ok) {
        if (!res.expired) toast.error(res.message)
        return false
      }
      if (!await flushOutgoingDraft()) return false
      const draft = await readDraftResult(docIdForPath(path))
      if (draft.status === 'invalid' || draft.status === 'unavailable') {
        toast.error(`Could not open ${path}: its draft is ${draft.status}.`)
        return false
      }
      if (draft.status === 'ok') draftBasesRef.current.set(docIdForPath(path), draft.value.baseRevision)
      setBaseline(res.content)
      setLoadedSha(res.sha)
      setOpenPath(path)
      // Only prefer the draft when it actually differs from what's saved.
      const draftDiffers = draft.status === 'ok' && contentDiffers(draft.value.content, res.content, fileKind(path))
      const content = draftDiffers && draft.status === 'ok' ? draft.value.content : res.content
      setText(content)
      workspaceStore.adopt(identityFor(path), content, res.content, res.sha, workspaceStore.active().generation)
      const needsReconciliation = draftDiffers && draft.status === 'ok' &&
        draftNeedsReconciliation(draft.value.baseRevision, res.sha)
      setDraftConflictKey(needsReconciliation ? documentKey(identityFor(path)) : null)
      if (needsReconciliation) setConflictOpen(true)
      return true
    },
    [hasWorkspace, pendingPaths, docIdForPath, readSaved, flushOutgoingDraft, setOpenPath, setText, workspaceStore, identityFor],
  )

  /** Open a file the user picked from the tree — the start of a new trail. */
  const openFromTree = useCallback(
    (path: string) => {
      setLinkTrail([])
      setMarkdownScrollTop(0)
      void openFile(path)
    },
    [openFile],
  )

  /** Open a file by following a link inside the open document. */
  const openLinkedFile = useCallback(
    (path: string, scrollTop: number) => {
      if (path === openPath) return
      void openFile(path).then((opened) => {
        if (!opened) return
        setLinkTrail((prev) => (openPath ? [...prev, { path: openPath, scrollTop }] : prev))
        setMarkdownScrollTop(0)
      })
    },
    [openFile, openPath],
  )

  const goBack = useCallback(() => {
    const target = linkTrail[linkTrail.length - 1]
    if (!target) return
    void openFile(target.path).then((opened) => {
      if (!opened) return
      setLinkTrail(linkTrail.slice(0, -1))
      setMarkdownScrollTop(target.scrollTop)
    })
  }, [linkTrail, openFile])

  const agentController = useAgentLinkController({
    enabled: agentLinkOn,
    configuredOrigin: config.mcpOrigin,
    defaultOrigin: DEFAULT_MCP_ORIGIN,
    githubEnabled,
    repo,
    openPath,
    kind,
    dirty,
    text,
    currentTheme,
    noneThemeValue: NONE_THEME,
    customThemeValue: CUSTOM_THEME,
    canvasTheme,
    hasWorkspace,
    localMode,
    savedPaths,
    pendingPaths,
    repoFilePaths,
    loadedSha,
    baseline,
    activeDocId: docId,
    appliedConfig,
    workspaceStore,
    openPathRef,
    activeIdentityRef,
    liveTextRef,
    workspaceSelectionRef,
    draftBasesRef,
    identityFor,
    docIdForPath,
    readSaved,
    validatePath,
    templateFor,
    setText,
    setOpenPath,
    setLoadedSha,
    setBaseline,
    setCreatedPaths,
    setDirtyPaths,
    clearLinkTrail,
    openFile,
    flushOutgoingDraft,
  })
  const {
    editorRef,
    markdownPreviewRef,
    revealInPreview,
    revealInEditor,
    mcpOrigin,
    agentLink,
    linkAttached,
    linkWaiting,
  } = agentController

  const newDiagram = useCallback(
    async (dirPath?: string, newKind: FileKind = 'mermaid') => {
      // Signed in with no repo picked: there is nowhere to put a named file, so
      // this is the untitled scratch document and nothing else.
      if (!hasWorkspace) {
        if (!await flushOutgoingDraft()) return
        setOpenPath(null)
        setLoadedSha(null)
        setBaseline(NEW_TEMPLATE)
        setText(NEW_TEMPLATE)
        return
      }
      // Only the *name* is typed: the folder (the repo root, or whichever folder's
      // "+" was used) and the extension (fixed by the kind chosen in the menu) are
      // shown around the field but can't be edited. A name may still contain
      // slashes, so creating a subfolder from the root "+" still works.
      const extension = extensionFor(newKind)
      const prefix = dirPath ? `${dirPath}/` : ''
      openPrompt({
        title:
          newKind === 'excalidraw'
            ? 'New canvas'
            : newKind === 'markdown'
              ? 'New document'
              : 'New diagram',
        description: localMode
          ? `Create a new file in ${dirPath || 'this browser'}. Nothing leaves the browser.`
          : `Create a new file in ${dirPath || 'the repository root'} on ${repo?.branch}.`,
        label: 'File name',
        defaultValue: 'untitled',
        prefix,
        suffix: extension,
        submitLabel: 'Start editing',
        validate: validateNewFilePath(extension),
        onSubmit: async (path) => {
          if (!savedPaths) {
            toast.error('The file list has not loaded yet. Try again in a moment.')
            return
          }
          if (savedPaths.has(path) || pendingPaths.has(path) ||
            (localMode && (await readLocalFileResult(path)).status !== 'missing') ||
            (await readDraftResult(docIdForPath(path))).status !== 'missing') {
            toast.error(`${path} already exists or its draft cannot be checked.`)
            return
          }
          if (!await flushOutgoingDraft()) return
          const body = templateFor(fileKind(path))
          // The draft is this file's only copy until it's saved — see the agent's
          // `createFile` for why it's written here and not by the effect.
          const written = await createDraftResult(docIdForPath(path), body)
          if (!written.ok) {
            toast.error(`Could not create ${path}: browser storage is ${written.reason}.`)
            return
          }
          setPromptOpen(false)
          setCreatedPaths((prev) => withPath(prev, path))
          setOpenPath(path)
          setLoadedSha(null)
          setBaseline('')
          setText(body)
        },
      })
    },
    [hasWorkspace, localMode, repo, docIdForPath, openPrompt, savedPaths, pendingPaths,
      flushOutgoingDraft, setOpenPath, setText, setCreatedPaths],
  )

  const requestRename = useCallback(
    (node: TreeNode) => {
      if (!hasWorkspace || node.type !== 'file') return
      // A never-committed file exists only in this browser: it is spliced into the sidebar from
      // `pendingPaths` and its content is an IndexedDB draft, with nothing on GitHub under either
      // name.
      const local = pendingPaths.has(node.path)
      // The extension is shown as an uneditable suffix, exactly as it is when creating a file.
      const extension = fileExtension(node.path)
      const stem = extension ? node.path.slice(0, node.path.length - extension.length) : node.path
      openPrompt({
        title: 'Rename file',
        description: localMode
          ? 'Move or rename this file. It is stored in this browser.'
          : local
            ? `Rename this file before its first commit. It only exists in this browser, so nothing on ${repo?.branch} changes until you commit.`
            : `Move or rename this file on ${repo?.branch}. Git history is preserved as a rename.`,
        label: 'New path',
        defaultValue: stem,
        suffix: extension,
        // Only the name is preselected: the folder is still editable, but it is
        // rarely the part being changed, and selecting the whole path meant the
        // first keystroke threw the folder away too.
        selection: 'name',
        submitLabel: 'Rename',
        validate: extension ? validateNewFilePath(extension) : validatePath,
        onSubmit: async (newPath) => workspaceStore.command(identityFor(node.path), async () => {
          if (newPath === node.path) {
            setPromptOpen(false)
            return
          }
          if (!savedPaths || savedPaths.has(newPath) || pendingPaths.has(newPath) ||
            (localMode && (await readLocalFileResult(newPath)).status !== 'missing') ||
            (await readDraftResult(docIdForPath(newPath))).status !== 'missing') {
            toast.error(`${newPath} already exists or its draft cannot be checked.`)
            return
          }
          if (!await flushOutgoingDraft()) return
          const operationWorkspace = workspaceSelectionRef.current
          const oldIdentity = identityFor(node.path)
          const newIdentity = identityFor(newPath)
          const oldKey = documentKey(oldIdentity)
          const activation = workspaceStore.active().generation
          let renamedSha: string | null | undefined
          const oldId = docIdForPath(node.path)
          const newId = docIdForPath(newPath)
          const draft = await readDraftResult(oldId)
          if (draft.status === 'invalid' || draft.status === 'unavailable' ||
            (local && draft.status === 'missing')) {
            toast.error(`Could not move ${node.path}'s draft: ${draft.status}.`)
            return
          }
          // IndexedDB moves the saved file and its working draft in one transaction.
          if (localMode) {
            const moved = await moveLocalFileAndDraft(node.path, newPath, oldId, newId, !local)
            if (!moved.ok) {
              toast.error(`Could not rename ${node.path}: ${moved.reason}.`)
              return
            }
            void refreshLocalFiles()
            if (!local) renamedSha = LOCAL_SAVED
          } else if (draft.status === 'ok') {
            const copied = await writeDraftResult(newId, draft.value.content, draft.value.baseRevision)
            if (!copied.ok) {
              toast.error(`Could not move ${node.path}'s draft: ${copied.reason}.`)
              return
            }
          }
          // The saved case has to land on the store first: everything below moves
          // local bookkeeping to match, and doing that before the write would
          // leave the app pointing at a path the store never got.
          if (!local && !localMode) {
            if (repo) {
              const res = await renameFile(
                repo.owner,
                repo.name,
                node.path,
                newPath,
                repo.branch,
              )
              if (!res.ok) {
                if (draft.status === 'ok' && !(await clearDraft(newId)).ok) {
                  toast.error(`Could not remove the extra draft at ${newPath}; the original remains safe.`)
                }
                if (handleExpiredSession(res.error)) return
                toast.error(res.error.message)
                return
              }
              renamedSha = res.data.sha
            }
          }
          workspaceStore.move(oldIdentity, newIdentity, renamedSha)
          const sameWorkspace = operationWorkspace === workspaceSelectionRef.current
          if (sameWorkspace) setPromptOpen(false)
          if (!localMode && draft.status === 'ok') {
            const removed = await clearDraft(oldId)
            if (!removed.ok) toast.error(`Renamed ${node.path}, but its old draft could not be cleared (${removed.reason}).`)
          }
          // A never-saved rename moves the only copy there is, so the pending set
          // has to follow it or the file drops out of the sidebar under both names.
          if (local && sameWorkspace) {
            setCreatedPaths((prev) => withPath(withoutPaths(prev, [node.path]), newPath))
          }
          if (sameWorkspace) setDirtyPaths((prev) => {
            if (!prev.has(node.path)) return prev
            const next = new Set(prev)
            next.delete(node.path)
            next.add(newPath)
            return next
          })
          if (sameWorkspace && workspaceStore.isActive(oldKey, activation)) {
            if (renamedSha !== undefined) setLoadedSha(renamedSha)
            setOpenPath(newPath)
          }
          toast.success(`Renamed to ${newPath}`)
          // A never-saved rename changed nothing on the branch, and `pendingPaths`
          // already re-splices the new name into the sidebar.
          if (!local && repo) void refreshTree(repo)
        }),
      })
    },
    [
      hasWorkspace,
      localMode,
      repo,
      openPrompt,
      pendingPaths,
      savedPaths,
      docIdForPath,
      flushOutgoingDraft,
      refreshLocalFiles,
      refreshTree,
      identityFor,
      workspaceStore,
      setOpenPath,
      setCreatedPaths,
      setDirtyPaths,
    ],
  )

  // Reset the editor to a fresh scratch doc — used when the file being edited is
  // deleted out from under it. Baseline is left empty (not equal to the text) so
  // the doc reads as unsaved and Save is enabled, prompting for a new path.
  const detachEditor = useCallback(() => {
    updateConfig({ scratchKind: 'mermaid' })
    setOpenPath(null)
    setLoadedSha(null)
    setBaseline('')
    setText(NEW_TEMPLATE)
    setLinkTrail([])
  }, [updateConfig, setOpenPath, setText])

  const requestDelete = useCallback((node: TreeNode) => {
    setDeleteTarget(node)
    setDeleteOpen(true)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!hasWorkspace || !deleteTarget) return
    const paths = collectFilePaths(deleteTarget)
    return workspaceStore.commandMany(paths.map((path) => identityFor(path)), async () => {
    const operationWorkspace = workspaceSelectionRef.current
    const deletedIdentities = paths.map((path) => identityFor(path))
    const activeAtDelete = workspaceStore.active()
    const affectsOpen = !!openPath && paths.includes(openPath)
    // A never-saved file (the pending new one) only exists as a draft — there is
    // nothing in the saved store to remove, so skip the write for it.
    const committed = paths.filter((p) => !pendingPaths.has(p))
    // Drop every draft under the deleted paths. Left behind, a draft *is* a
    // never-saved file as far as the recovery effect above is concerned, so a
    // deleted file would reappear as a new one on the next load.
    const forget = async (draftsAlreadyCleared = false): Promise<boolean> => {
      if (!draftsAlreadyCleared) {
        const results = await Promise.all(paths.map((path) => clearDraft(docIdForPath(path))))
        const failed = results.find((result) => !result.ok)
        if (failed && !failed.ok) {
          toast.error(`Files were deleted, but their drafts remain in browser storage (${failed.reason}).`)
          return false
        }
      }
      for (const identity of deletedIdentities) workspaceStore.forget(identity)
      if (operationWorkspace === workspaceSelectionRef.current) {
        setCreatedPaths((prev) => withoutPaths(prev, paths))
        setDirtyPaths((prev) => withoutPaths(prev, paths))
      }
      return true
    }
    if (committed.length === 0) {
      const removed = await deleteLocalFilesAndDrafts([], paths.map(docIdForPath))
      if (!removed.ok) {
        toast.error(`Could not delete unsaved files from browser storage (${removed.reason}).`)
        return
      }
      if (affectsOpen && workspaceStore.active().generation === activeAtDelete.generation) detachEditor()
      await forget(true)
      setDeleteOpen(false)
      setDeleteTarget(null)
      return
    }
    if (localMode) {
      const removed = await deleteLocalFilesAndDrafts(committed, paths.map(docIdForPath))
      if (!removed.ok) {
        toast.error(`Could not delete files from browser storage (${removed.reason}).`)
        return
      }
      void refreshLocalFiles()
      await forget(true)
      setDeleteOpen(false)
      setDeleteTarget(null)
      if (affectsOpen && workspaceStore.active().generation === activeAtDelete.generation) detachEditor()
      toast.success(
        committed.length === 1 ? `Deleted ${committed[0]}` : `Deleted ${committed.length} files`,
      )
      return
    }
    if (!repo) return
    setDeleteBusy(true)
    const res = await deletePaths(repo.owner, repo.name, committed, repo.branch)
    setDeleteBusy(false)
    if (!res.ok) {
      if (handleExpiredSession(res.error)) return
      toast.error(res.error.message)
      return
    }
    toast.success(
      res.data.deleted === 1
        ? `Deleted ${committed[0]}`
        : `Deleted ${res.data.deleted} files`,
    )
    if (await forget()) {
      if (operationWorkspace === workspaceSelectionRef.current) {
        setDeleteOpen(false)
        setDeleteTarget(null)
      }
      if (affectsOpen && workspaceStore.active().generation === activeAtDelete.generation) detachEditor()
    }
    void refreshTree(repo)
    })
  }, [
    hasWorkspace,
    localMode,
    repo,
    deleteTarget,
    pendingPaths,
    openPath,
    docIdForPath,
    refreshLocalFiles,
    detachEditor,
    refreshTree,
    identityFor,
    workspaceStore,
    setCreatedPaths,
    setDirtyPaths,
  ])

  /** Bookkeeping for a path that was committed while the user was looking at something else. */
  const settleCommitted = useCallback(
    async (path: string, content: string, draftId = docIdForPath(path), updateMarkers = true) => {
      const draft = await readDraftResult(draftId)
      if (draft.status === 'invalid' || draft.status === 'unavailable') {
        toast.error(`Could not settle ${path}'s draft: ${draft.status}.`)
        return
      }
      const outstanding = draft.status === 'ok' && contentDiffers(draft.value.content, content, fileKind(path))
      if (outstanding) return
      if (draft.status === 'ok' && !(await clearDraft(draftId)).ok) {
        toast.error(`Could not clear ${path}'s saved draft.`)
        return
      }
      if (updateMarkers) setDirtyPaths((prev) => withoutPaths(prev, [path]))
    },
    [docIdForPath, setDirtyPaths],
  )

  const settleSavedRecord = useCallback(async (identity: DocumentIdentity, content: string,
    sha: string, submittedRevision: number, draftId: string) => {
    const key = documentKey(identity)
    const current = workspaceStore.get(key)
    const draft = await readDraftResult(draftId)
    if (draft.status === 'ok' && contentDiffers(draft.value.content, content, identity.kind) &&
        (!current || current.revision === submittedRevision)) {
      workspaceStore.edit(identity, draft.value.content)
    }
    workspaceStore.settleSave(identity, content, sha, submittedRevision)
    if (draft.status === 'ok' && contentDiffers(draft.value.content, content, identity.kind)) {
      const rebased = draftBaseFor(sha)
      draftBasesRef.current.set(draftId, rebased)
      const persisted = await writeDraftResult(draftId, draft.value.content, rebased)
      if (!persisted.ok) workspaceStore.markPersistence(key, 'failed')
    } else {
      draftBasesRef.current.delete(draftId)
    }
  }, [workspaceStore])

  /** The open document, readable after an await. `openPath` in a closure is the
   *  value at the moment the request went out, which is the one question a commit
   *  landing later must not ask. */
  openPathRef.current = openPath

  const commitCurrent = useCallback(
    async (path: string, sha: string | undefined, content: string) => {
      if (!repo) return
      // Which document this commit came from, so the result can tell whether it is
      // still the one on screen. Compared rather than `path`: committing an
      // untitled document *gives* it a path, so `origin` is null there and the
      // adoption below is exactly what promotes it.
      const origin = openPathRef.current
      const originIdentity = identityFor(origin)
      const targetIdentity = identityFor(path)
      const originKey = documentKey(originIdentity)
      const originGeneration = workspaceStore.active().generation
      const submittedRevision = workspaceStore.get(originKey)?.revision ?? workingRevisionRef.current
      const submittedWorkspace = workspaceSelectionRef.current
      const submittedDraftId = docIdForFile(repo.owner, repo.name, repo.branch, path)
      setSaving(true)
      const res = await commitFile(repo.owner, repo.name, path, content, repo.branch, sha)
      setSaving(false)
      if (res.ok) {
        const sameWorkspace = submittedWorkspace === workspaceSelectionRef.current
        const stillActive = workspaceStore.isActive(originKey, originGeneration) && sameWorkspace
        if (origin === null && stillActive && liveTextRef.current !== content) {
          workspaceStore.edit(targetIdentity, liveTextRef.current)
        }
        await settleSavedRecord(targetIdentity, content, res.data.sha, submittedRevision, submittedDraftId)
        // The path is on the branch now — the next tree fetch will carry it, so it
        // must stop being spliced in as a never-committed file. Hand it to the
        // tree in the same batch, or the sidebar drops the file for the length of
        // that fetch (see `treeWithPath`).
        if (sameWorkspace) {
          setCreatedPaths((prev) => withoutPaths(prev, [path]))
          setTree((prev) => (prev ? treeWithPath(prev, path) : prev))
        }
        // Committing an untitled scratch document promotes it to a real file, so
        // its parked draft is spent — clear the slot for the kind it came from,
        // not just the mermaid one.
        if (origin === null && sameWorkspace) {
          const parked = await readDraftResult(scratchDocId)
          if (canConsumeScratchDraft(true, content, parked.status === 'ok' ? parked.value.content : null,
            submittedRevision, workspaceStore.get(originKey)?.revision ?? submittedRevision)) {
            await clearDraft(scratchDocId)
          }
        }
        if (stillActive) {
          setBaseline(content)
          setLoadedSha(res.data.sha)
          setOpenPath(path)
          // The dirty effect and the draft effect both key on the open document,
          // so a clean baseline is all it takes to clear the marker and the slot.
        } else {
          await settleCommitted(path, content, submittedDraftId, sameWorkspace)
        }
        toast.success(`Committed ${path}`)
        void refreshTree(repo)
        return
      }
      if (handleExpiredSession(res.error)) return
      // The conflict modal acts on the *open* file — refetch its sha, commit on
      // top — so it can only be offered while that is still the file in question.
      if (res.error.kind === 'conflict' && workspaceStore.isActive(originKey, originGeneration) &&
          submittedWorkspace === workspaceSelectionRef.current) setConflictOpen(true)
      else toast.error(res.error.message)
    },
    [repo, refreshTree, scratchDocId, settleCommitted, settleSavedRecord, identityFor,
      workspaceStore, setOpenPath, setCreatedPaths],
  )

  /** Save to the local store — local mode's whole of `commitCurrent`. */
  const saveLocal = useCallback(
    async (path: string, content: string, fromScratch = false) => {
      const identity = identityFor(path)
      const submittedRevision = workspaceStore.get(documentKey(identity))?.revision ?? 0
      const draftToClear = fromScratch ? scratchDocId : docIdForPath(path)
      const written = await saveLocalFileAndClearDraft(path, content, draftToClear, fromScratch,
        fromScratch ? docIdForPath(path) : undefined)
      if (!written.ok) {
        toast.error(
          `Could not save ${path} — browser storage is ${written.reason}. ` +
            'Export what you need, or delete a file you are done with.',
        )
        return
      }
      workspaceStore.settleSave(identity, content, LOCAL_SAVED, submittedRevision)
      setBaseline(content)
      setLoadedSha(LOCAL_SAVED)
      setOpenPath(path)
      setCreatedPaths((prev) => withoutPaths(prev, [path]))
      void refreshLocalFiles()
      toast.success(`Saved ${path}`)
    },
    [refreshLocalFiles, scratchDocId, identityFor, workspaceStore, setOpenPath,
      docIdForPath, setCreatedPaths],
  )

  const onSave = useCallback(async () => {
    if (!hasWorkspace || !dirty || saving) return
    if (openPath && draftConflictKey === documentKey(identityFor(openPath))) {
      setConflictOpen(true)
      return
    }
    if (openPath === null) {
      openPrompt({
        title: localMode ? 'Save file' : 'Save to repository',
        description: localMode
          ? 'Choose a path for this document. It is saved in this browser.'
          : `Choose a path on ${repo?.branch} for this document.`,
        label: 'File path',
        defaultValue: defaultFileName(kind, 'untitled'),
        submitLabel: 'Save',
        validate: validatePathForKind(kind),
        onSubmit: async (path) => {
          if (!savedPaths || savedPaths.has(path) || pendingPaths.has(path) ||
            (localMode && (await readLocalFileResult(path)).status !== 'missing') ||
            (await readDraftResult(docIdForPath(path))).status !== 'missing') {
            toast.error(`${path} already exists or its draft cannot be checked.`)
            return
          }
          setPromptOpen(false)
          if (localMode) await saveLocal(path, text, true)
          else void commitCurrent(path, undefined, text)
        },
      })
      return
    }
    if (localMode) await saveLocal(openPath, text)
    else void commitCurrent(openPath, loadedSha ?? undefined, text)
  }, [
    hasWorkspace,
    localMode,
    repo,
    dirty,
    saving,
    openPath,
    loadedSha,
    text,
    kind,
    commitCurrent,
    saveLocal,
    openPrompt,
    savedPaths,
    pendingPaths,
    docIdForPath,
    draftConflictKey,
    identityFor,
  ])

  /* ---------------------------------------------------------------- */
  /* Save all                                                          */
  /* ---------------------------------------------------------------- */

  /** Every path Save All would write — each file with unsaved changes. */
  const saveAllPaths = useMemo(() => [...dirtyPaths].sort(), [dirtyPaths])

  /** The working copy of `path`, wherever it is living. */
  const workingCopy = useCallback(
    async (path: string): Promise<string | null> => {
      if (path === openPath) return text
      const draft = await readDraftResult(docIdForPath(path))
      return draft.status === 'ok' ? draft.value.content : null
    },
    [openPath, text, docIdForPath],
  )

  /** Save every changed file — **one** commit, not one per file. */
  const onSaveAll = useCallback(async () => {
    if (!hasWorkspace || saving || saveAllPaths.length === 0) return

    if (localMode) {
      const { saved, failed } = await saveLocalBatch(saveAllPaths, workingCopy, docIdForPath)
      const savedPathsThisRun = saved.map(({ path }) => path)
      for (const { path, content } of saved) {
        const identity = identityFor(path)
        workspaceStore.settleSave(identity, content, LOCAL_SAVED,
          workspaceStore.get(documentKey(identity))?.revision ?? 0)
        if (path === openPath) {
          setBaseline(content)
          setLoadedSha(LOCAL_SAVED)
        } else {
          await settleCommitted(path, content)
        }
      }
      setCreatedPaths((prev) => withoutPaths(prev, savedPathsThisRun))
      void refreshLocalFiles()
      if (failed.length > 0) {
        toast.error(
          `Could not save ${failed.join(', ')} in browser storage. ` +
            'Export what you need, or delete a file you are done with.',
        )
      }
      if (savedPathsThisRun.length > 0) toast.success(savedPathsThisRun.length === 1 ? `Saved ${savedPathsThisRun[0]}` : `Saved ${savedPathsThisRun.length} files`)
      return
    }

    if (!repo) return
    const submittedWorkspace = workspaceSelectionRef.current
    const activeAtSubmit = workspaceStore.active()
    const submitted = new globalThis.Map<string, { content: string; revision: number }>()
    for (const path of saveAllPaths) {
      const content = await workingCopy(path)
      if (content === null) {
        toast.error(`Could not read the unsaved copy of ${path}. Nothing was committed.`)
        return
      }
      const identity: DocumentIdentity = {
        workspace: { mode: 'github', owner: repo.owner, repo: repo.name, branch: repo.branch },
        path, kind: fileKind(path),
      }
      submitted.set(path, { content, revision: workspaceStore.get(documentKey(identity))?.revision ?? 0 })
    }
    setSaving(true)
    const writes: FileWrite[] = []
    const alreadySaved: string[] = []
    for (const path of saveAllPaths) {
      const content = submitted.get(path)!.content
      // Never committed: nothing on the branch to be stale against.
      if (pendingPaths.has(path)) {
        writes.push({ path, content })
        continue
      }
      if (path === openPath && loadedSha !== null) {
        const base = draftBasesRef.current.get(docIdForPath(path))
        if (base && draftNeedsReconciliation(base, loadedSha)) {
          setSaving(false)
          setDraftConflictKey(documentKey(identityFor(path)))
          setConflictOpen(true)
          toast.error(`${path} has unsaved work based on an older or unknown revision. Reconcile it before Save All.`)
          return
        }
        writes.push({ path, content, sha: loadedSha })
        continue
      }
      const current = await readSaved(path)
      if (!current.ok) {
        setSaving(false)
        if (!current.expired) toast.error(current.message)
        return
      }
      const draft = await readDraftResult(docIdForPath(path))
      if (draft.status !== 'ok') {
        setSaving(false)
        toast.error(`Could not verify ${path}'s draft base (${draft.status}). Nothing was committed.`)
        return
      }
      if (draftNeedsReconciliation(draft.value.baseRevision, current.sha)) {
        setSaving(false)
        toast.error(`${path} has unsaved work based on an older or unknown revision. Open it to reconcile before Save All.`)
        return
      }
      if (!contentDiffers(content, current.content, fileKind(path))) {
        alreadySaved.push(path)
        continue
      }
      writes.push({ path, content, sha: current.sha })
    }

    // Everything that looked dirty turned out to match the branch — no commit to
    // make, just markers to put out.
    if (writes.length === 0) {
      setSaving(false)
      for (const path of alreadySaved) await settleCommitted(path, submitted.get(path)?.content ?? '',
        docIdForFile(repo.owner, repo.name, repo.branch, path),
        submittedWorkspace === workspaceSelectionRef.current)
      toast.success('Everything is already committed.')
      return
    }

    const summary =
      writes.length === 1
        ? `Update ${writes[0]!.path} via ${APP_NAME}`
        : `Update ${writes.length} files via ${APP_NAME}`
    const message =
      writes.length === 1
        ? summary
        : `${summary}\n\n${writes.map((w) => `- ${w.path}`).join('\n')}`

    const res = await commitFiles(repo.owner, repo.name, writes, repo.branch, message)
    setSaving(false)
    if (!res.ok) {
      if (handleExpiredSession(res.error)) return
      // Deliberately not the conflict modal: its two choices ("overwrite" /
      // "start over") act on the open file, and the file that went stale here is
      // usually not the one on screen. The message names the paths instead.
      toast.error(res.error.message)
      return
    }

    for (const file of res.data.files) {
      const identity: DocumentIdentity = {
        workspace: { mode: 'github', owner: repo.owner, repo: repo.name, branch: repo.branch },
        path: file.path, kind: fileKind(file.path),
      }
      await settleSavedRecord(identity, file.content, file.sha, submitted.get(file.path)?.revision ?? 0,
        docIdForFile(repo.owner, repo.name, repo.branch, file.path))
      const sameWorkspace = submittedWorkspace === workspaceSelectionRef.current
      if (sameWorkspace && workspaceStore.isActive(documentKey(identity), activeAtSubmit.generation)) {
        setBaseline(file.content)
        setLoadedSha(file.sha)
      } else {
        await settleCommitted(file.path, file.content,
          docIdForFile(repo.owner, repo.name, repo.branch, file.path), sameWorkspace)
      }
    }
    for (const path of alreadySaved) await settleCommitted(path, submitted.get(path)?.content ?? '',
      docIdForFile(repo.owner, repo.name, repo.branch, path),
      submittedWorkspace === workspaceSelectionRef.current)
    const committed = res.data.files.map((f) => f.path)
    if (submittedWorkspace === workspaceSelectionRef.current) {
      setCreatedPaths((prev) => withoutPaths(prev, committed))
      setTree((prev) => (prev ? committed.reduce(treeWithPath, prev) : prev))
    }
    toast.success(
      committed.length === 1
        ? `Committed ${committed[0]}`
        : `Committed ${committed.length} files in one commit`,
    )
    void refreshTree(repo)
  }, [
    hasWorkspace,
    localMode,
    saving,
    saveAllPaths,
    workingCopy,
    openPath,
    loadedSha,
    pendingPaths,
    repo,
    readSaved,
    settleCommitted,
    refreshLocalFiles,
    refreshTree,
    workspaceStore,
    identityFor,
    settleSavedRecord,
    docIdForPath,
    setCreatedPaths,
  ])

  // Discard uncommitted edits, resetting the editor back to the last-loaded
  // commit. Only meaningful once there is an actual commit to fall back to
  // (loadedSha !== null) — a never-committed file has no "last commit" state.
  const canRestore = dirty && loadedSha !== null
  const onRestore = useCallback(async () => {
    if (!canRestore) return
    const cleared = await clearDraft(docId)
    if (!cleared.ok) {
      toast.error(`Could not discard the draft in browser storage (${cleared.reason}).`)
      return
    }
    setText(baseline)
  }, [canRestore, baseline, docId, setText])

  // Detect the platform for the correct modifier label (⌘ vs Ctrl).
  useEffect(() => {
    setIsMac(/mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent))
  }, [])

  // Keyboard shortcuts, wherever there are files to act on: ⌘/Ctrl+S saves; ⌘/Ctrl+Alt+N starts a
  // new diagram.
  useEffect(() => {
    if (!hasWorkspace) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.code === 'KeyS' && !e.altKey) {
        e.preventDefault()
        onSave()
      } else if (e.code === 'KeyN' && e.altKey) {
        e.preventDefault()
        newDiagram()
      } else if (e.code === 'KeyB' && !e.altKey) {
        e.preventDefault()
        setSidebarOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasWorkspace, onSave, newDiagram])

  const onOverwrite = useCallback(async () => {
    if (!repo || !openPath) return
    const identity = identityFor(openPath)
    const key = documentKey(identity)
    const generation = workspaceStore.active().generation
    const submittedContent = text
    const submittedRevision = workspaceStore.get(key)?.revision ?? 0
    setConflictBusy(true)
    const fresh = await readFile(repo.owner, repo.name, openPath, repo.branch)
    if (!fresh.ok) {
      setConflictBusy(false)
      if (handleExpiredSession(fresh.error)) return
      toast.error(fresh.error.message)
      return
    }
    if (!workspaceStore.isActive(key, generation)) {
      setConflictBusy(false)
      return
    }
    const res = await commitFile(repo.owner, repo.name, openPath, submittedContent, repo.branch, fresh.data.sha)
    setConflictBusy(false)
    if (res.ok) {
      await settleSavedRecord(identity, submittedContent, res.data.sha, submittedRevision,
        docIdForFile(repo.owner, repo.name, repo.branch, openPath))
      setDraftConflictKey(null)
      if (workspaceStore.isActive(key, generation)) {
        setBaseline(submittedContent)
        setLoadedSha(res.data.sha)
        setConflictOpen(false)
      }
      await settleCommitted(openPath, submittedContent,
        docIdForFile(repo.owner, repo.name, repo.branch, openPath),
        workspaceStore.isActive(key, generation))
      toast.success('Overwritten on top of latest')
      void refreshTree(repo)
    } else if (!handleExpiredSession(res.error)) {
      toast.error(res.error.message)
    }
  }, [repo, openPath, text, refreshTree, identityFor, workspaceStore, settleCommitted, settleSavedRecord])

  const onStartOver = useCallback(async () => {
    if (!repo || !openPath) return
    const key = documentKey(identityFor(openPath))
    const generation = workspaceStore.active().generation
    setConflictBusy(true)
    const fresh = await readFile(repo.owner, repo.name, openPath, repo.branch)
    setConflictBusy(false)
    if (!workspaceStore.isActive(key, generation)) return
    if (!fresh.ok) {
      if (handleExpiredSession(fresh.error)) return
      toast.error(fresh.error.message)
      return
    }
    const cleared = await clearDraft(docId)
    if (!cleared.ok) {
      toast.error(`Could not discard the draft in browser storage (${cleared.reason}).`)
      return
    }
    setText(fresh.data.content)
    setBaseline(fresh.data.content)
    setLoadedSha(fresh.data.sha)
    workspaceStore.adopt(identityFor(openPath), fresh.data.content, fresh.data.content,
      fresh.data.sha, generation)
    setDraftConflictKey(null)
    setConflictOpen(false)
  }, [repo, openPath, docId, setText, identityFor, workspaceStore])

  const canSave =
    hasWorkspace && dirty && ((openPath !== null && loadedSha === null) || text.trim().length > 0) && !saving
  /**
   * Whether the save control splits. Not simply "more than one file is dirty": the condition is
   * that there is unsaved work the primary button would *not* reach.
   */
  const showSaveAll =
    hasWorkspace &&
    (saveAllPaths.length > 1 || (saveAllPaths.length === 1 && saveAllPaths[0] !== openPath))
  // A canvas has no text to diff, and a file with nothing saved behind it has
  // nothing to diff against.
  const canDiff = kind !== 'excalidraw' && loadedSha !== null
  const showSidebar = hasWorkspace && sidebarOpen
  const saveHint = isMac ? '⌘ S' : 'Ctrl + S'
  const newHint = isMac ? '⌥ ⌘ N' : 'Ctrl + Alt + N'
  const sidebarHint = isMac ? '⌘ B' : 'Ctrl + B'

  return (
    <AppLayout
      header={
        <AppHeader
          githubEnabled={githubEnabled}
          hasWorkspace={hasWorkspace}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((value) => !value)}
          sidebarHint={sidebarHint}
          repo={repo}
          onOpenRepoPicker={() => setRepoPickerOpen(true)}
          onOpenBranchPicker={() => setBranchPickerOpen(true)}
          onRestore={() => void onRestore()}
          canRestore={canRestore}
          localMode={localMode}
          onSave={() => void onSave()}
          canSave={canSave}
          saving={saving}
          showSaveAll={showSaveAll}
          saveAllPaths={saveAllPaths}
          saveHint={saveHint}
          isMac={isMac}
          onSaveAll={() => void onSaveAll()}
          onOpenPath={openFromTree}
          dirty={dirty}
          openPath={openPath}
          onOpenHistory={() => void history.openHistory()}
          exportText={debouncedText}
          baseName={baseName}
          config={config}
          updateConfig={updateConfig}
          appliedConfig={appliedConfig}
          kind={kind}
          user={user}
        />
      }
      sidebar={
        showSidebar ? (
          <WorkspaceSidebar
            width={sidebarWidth}
            dirtyCount={dirtyPaths.size}
            repoBranch={repo?.branch ?? null}
            treeLoading={treeLoading}
            onRefresh={() => {
              if (repo) void refreshTree(repo)
            }}
            newHint={newHint}
            onNewFile={(dir, selectedKind) => newDiagram(dir, selectedKind)}
            hasDisplayNodes={displayNodes.length > 0}
            fileFilter={fileFilter}
            onFileFilterChange={setFileFilter}
            searching={searching}
            truncated={tree?.truncated ?? false}
            treeError={treeError}
            treeLoaded={tree !== null}
            localMode={localMode}
            visibleNodes={visibleNodes}
            activePath={openPath}
            dirtyPaths={dirtyPaths}
            expandedPaths={visibleExpanded}
            onToggleDir={toggleVisibleDir}
            onOpenFile={openFromTree}
            onDelete={requestDelete}
            onRename={requestRename}
          />
        ) : null
      }
      showSidebar={showSidebar}
      sidebarWidth={sidebarWidth}
      minSidebarWidth={MIN_SIDEBAR_WIDTH}
      maxSidebarWidth={MAX_SIDEBAR_WIDTH}
      onSidebarPointerDown={startSidebarDrag}
      onSidebarKeyDown={onSidebarDividerKeyDown}
      dialogs={
        <AppDialogs
          githubEnabled={githubEnabled}
          repoPickerOpen={repoPickerOpen}
          onRepoPickerOpenChange={setRepoPickerOpen}
          onSelectRepo={(selectedRepo) => void onSelectRepo(selectedRepo)}
          repo={repo}
          branchPickerOpen={branchPickerOpen}
          onBranchPickerOpenChange={setBranchPickerOpen}
          branchBusy={branchBusy}
          onSelectBranch={(branch) => void onSelectBranch(branch)}
          onCreateBranch={(branch) => void onCreateBranch(branch)}
          openPath={openPath}
          conflictOpen={conflictOpen}
          onConflictOpenChange={setConflictOpen}
          conflictBusy={conflictBusy}
          onOverwrite={() => void onOverwrite()}
          onStartOver={() => void onStartOver()}
          reconciliation={openPath !== null && draftConflictKey === documentKey(identityFor(openPath))}
          prompt={prompt}
          promptOpen={promptOpen}
          onPromptOpenChange={setPromptOpen}
          configOpen={configOpen}
          onConfigOpenChange={setConfigOpen}
          mermaidConfig={config.mermaidConfig}
          onMermaidConfigChange={(value) => updateConfig({ mermaidConfig: value })}
          configError={parsedConfig.error}
          linkOpen={linkOpen}
          onLinkOpenChange={setLinkOpen}
          agentLinkOn={agentLinkOn}
          onAgentLinkEnabledChange={enableAgentLink}
          agentLink={agentLink}
          mcpOrigin={mcpOrigin}
          onMcpOriginChange={(origin) => updateConfig({ mcpOrigin: origin })}
          mode={mode}
          deleteOpen={deleteOpen}
          onDeleteOpenChange={setDeleteOpen}
          deleteTarget={deleteTarget}
          deleteBusy={deleteBusy}
          onConfirmDelete={() => void confirmDelete()}
          history={history}
          appliedConfig={appliedConfig}
          kind={kind}
          canvasTheme={canvasTheme}
          canvasBackground={canvasBackground}
          mobileWarningOpen={mobileWarningOpen}
          onMobileWarningOpenChange={(nextOpen) => {
            setMobileWarningOpen(nextOpen)
            if (!nextOpen) setMobileWarningDismissed(true)
          }}
        />
      }
    >
      <DocumentToolbar
        hasWorkspace={hasWorkspace}
        linkTrail={linkTrail}
        onBack={goBack}
        openPath={openPath}
        localMode={localMode}
        kind={kind}
        onSwitchScratchKind={(nextKind) => void switchScratchKind(nextKind)}
        showDiff={showDiff}
        canDiff={canDiff}
        onToggleDiff={() => setShowDiff((value) => !value)}
        config={config}
        updateConfig={updateConfig}
        currentTheme={currentTheme}
        customThemeValue={CUSTOM_THEME}
        noneThemeValue={NONE_THEME}
        onApplyTheme={applyTheme}
        currentLayout={currentLayout}
        onOpenConfig={() => setConfigOpen(true)}
        linkAttached={linkAttached}
        linkWaiting={linkWaiting}
        agentLinkOn={agentLinkOn}
        agentLink={agentLink}
        onOpenAgentLink={() => setLinkOpen(true)}
      />
      <DocumentSurface
        kind={kind}
        openPath={openPath}
        documentId={documentKey(activeIdentityRef.current)}
        text={text}
        onChange={setText}
        canvasTheme={canvasTheme}
        canvasBackground={canvasBackground}
        showDiff={showDiff}
        canDiff={canDiff}
        baseline={baseline}
        renderedText={debouncedText}
        paneRowRef={paneRowRef}
        editorRatio={editorRatio}
        onDividerPointerDown={startDividerDrag}
        onDividerKeyDown={onDividerKeyDown}
        editorRef={editorRef}
        markdownPreviewRef={markdownPreviewRef}
        editorDark={editorDark}
        wrapLines={config.wrapLines}
        loaded={loadedSha !== null}
        filePaths={repoFilePaths}
        minimap={config.minimap}
        onRevealPreview={revealInPreview}
        onRevealEditor={revealInEditor}
        config={appliedConfig}
        repo={repo}
        onOpenLinkedFile={openLinkedFile}
        linkTrail={linkTrail}
        markdownScrollTop={markdownScrollTop}
        onBack={goBack}
      />
    </AppLayout>
  )
}

/** Accepts any recognized extension — used when *creating* a file, where the
 *  extension the user types is what chooses the editor. */
function validatePath(value: string): string | null {
  if (!value) return 'Enter a file path.'
  if (value.startsWith('/') || value.includes('..')) return 'Use a repo-relative path.'
  if (!isDiagramFile(value)) return `Use one of: ${DIAGRAM_EXTENSIONS_LABEL}.`
  return null
}

/**
 * The create prompt's validation. The extension is supplied by the prompt itself, so the only new
 * failure mode is an empty name — which would otherwise assemble into a dotfile (`docs/.md`) that
 * `validatePath` happily accepts.
 */
function validateNewFilePath(extension: string): (value: string) => string | null {
  return (value: string) => {
    const name = value.slice(0, value.length - extension.length).split('/').pop() ?? ''
    if (!name.trim()) return 'Enter a file name.'
    if (name.toLowerCase().endsWith(extension)) {
      return `The ${extension} extension is added for you.`
    }
    return validatePath(value)
  }
}

/**
 * Requires an extension matching `kind` — used when an *existing* document is written to a new path
 * (save-as, fork from history).
 */
function validatePathForKind(kind: FileKind): (value: string) => string | null {
  return (value: string) => {
    const base = validatePath(value)
    if (base) return base
    if (fileKind(value) !== kind) {
      switch (kind) {
        case 'excalidraw':
          return `This is a canvas — use a ${EXCALIDRAW_EXTENSION} extension.`
        case 'markdown':
          return 'This is a Markdown document — use a .md or .markdown extension.'
        case 'mermaid':
          return 'This is a Mermaid diagram — use a .mmd or .mermaid extension.'
      }
    }
    return null
  }
}
