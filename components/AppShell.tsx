'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  Command,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitPullRequestArrow,
  History,
  PanelLeft,
  Map,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  WrapText,
} from 'lucide-react'
import { toast } from 'sonner'
import Editor from './Editor'
import Preview from './Preview'
import MarkdownPreview from './MarkdownPreview'
import Canvas from './Canvas'
import ExportMenu from './ExportMenu'
import AuthButton from './AuthButton'
import RepoPicker from './RepoPicker'
import BranchPicker from './BranchPicker'
import FileTree, { FileTreeSkeleton } from './FileTree'
import ConflictModal from './ConflictModal'
import DeleteModal from './DeleteModal'
import PromptModal, { type PromptModalProps } from './PromptModal'
import HistoryPanel, { type HistoryCompare, type HistoryView } from './HistoryPanel'
import DiffView from './DiffView'
import NewFileMenu from './NewFileMenu'
import { ExcalidrawIcon, MarkdownIcon, MermaidIcon } from './icons'
import ConfigModal from './ConfigModal'
import MobileWarningModal from './MobileWarningModal'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
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
import { DEFAULT_LAYOUT, LAYOUT_ENGINES } from '@/lib/mermaid'
import {
  parseMermaidConfig,
  applyThemeToSite,
  layoutFromConfig,
  resolveThemeMode,
  setLayoutInYaml,
  setThemeInYaml,
  themeBackgroundColor,
  themeFromConfig,
  type MermaidUserConfig,
} from '@/lib/mermaidConfig'
import { THEME_PRESETS } from '@/lib/themes'
import { useDebouncedValue, useIsMobile } from '@/lib/hooks'
import { handleExpiredSession } from '@/lib/sessionExpiry'
import {
  loadConfig,
  saveConfig,
  loadDraft,
  saveDraft,
  clearDraft,
  docIdForFile,
  scratchDocIdFor,
} from '@/lib/storage'
import { APP_NAME } from '@/lib/config'
import {
  buildTree,
  collectFilePaths,
  fileKind,
  isDiagramFile,
  DIAGRAM_EXTENSIONS_LABEL,
  EXCALIDRAW_EXTENSION,
  type FileKind,
} from '@/lib/tree'
import { EMPTY_SCENE, scenesEqual } from '@/lib/excalidraw'
import { cn } from '@/lib/utils'
import {
  listTree,
  readFile,
  readFileAtRef,
  listFileCommits,
  commitFile,
  deletePaths,
  renameFile,
  createBranch,
  type TreeResult,
} from '@/app/actions/github'
import type { AppConfig, FileCommit, Repo, RepoRef, SessionUser, TreeNode } from '@/lib/types'

export interface AppShellProps {
  user: SessionUser | null
  mode: 'local' | 'github'
}

const SAMPLE = `flowchart TD
  A[Working copy in localStorage] -->|Save = commit| B(GitHub repo)
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

// Sentinel Select values for the theme dropdown: "None" strips the theme (revert
// to the default look), "Custom" is the read-only display state when the config's
// palette matches no preset (e.g. hand-edited themeVariables).
const NONE_THEME = '__none__'
const CUSTOM_THEME = '__custom__'
const HISTORY_PAGE_SIZE = 30

/** A new Set with `paths` removed — used to clear dirty-tracking on delete/commit. */
function withoutPaths(set: ReadonlySet<string>, paths: string[]): ReadonlySet<string> {
  if (!paths.some((p) => set.has(p))) return set
  const next = new Set(set)
  for (const p of paths) next.delete(p)
  return next
}

type PromptSpec = Pick<
  PromptModalProps,
  | 'title'
  | 'description'
  | 'label'
  | 'defaultValue'
  | 'prefix'
  | 'suffix'
  | 'submitLabel'
  | 'validate'
  | 'onSubmit'
>

export default function AppShell({ user, mode }: AppShellProps) {
  const githubEnabled = mode === 'github' && !!user

  const [config, setConfig] = useState<AppConfig>({
    repo: null,
    exportBackground: 'white',
    splitRatio: 0.5,
    sidebarWidth: 256,
    wrapLines: false,
    minimap: true,
    scratchKind: 'mermaid',
    mermaidConfig: '',
  })
  const [hydrated, setHydrated] = useState(false)
  const [isMac, setIsMac] = useState(false)

  // Warn on small screens once per load — the layout needs room for the editor
  // and preview side by side, but the user can dismiss and continue anyway.
  const isMobile = useIsMobile()
  const [mobileWarningOpen, setMobileWarningOpen] = useState(false)
  const [mobileWarningDismissed, setMobileWarningDismissed] = useState(false)
  useEffect(() => {
    if (isMobile && !mobileWarningDismissed) setMobileWarningOpen(true)
  }, [isMobile, mobileWarningDismissed])

  // Live editor/preview split ratio (persisted to config on drag end).
  const [editorRatio, setEditorRatio] = useState(0.5)
  const paneRowRef = useRef<HTMLDivElement>(null)

  // Live sidebar width in pixels (persisted to config on drag end).
  const [sidebarWidth, setSidebarWidth] = useState(256)

  const [text, setText] = useState(SAMPLE)
  const [baseline, setBaseline] = useState(SAMPLE)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [loadedSha, setLoadedSha] = useState<string | null>(null)
  // Files opened by following a link inside a document, so there is a way back.
  // Only link navigation pushes: picking a file in the tree is a fresh start, not
  // a step in a trail, and a Back button that then jumped somewhere unrelated
  // would be worse than none.
  const [linkTrail, setLinkTrail] = useState<string[]>([])

  const [tree, setTree] = useState<TreeResult | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  // Tracked separately from `tree === null` so a refresh can spin the button and
  // report failure without blanking a list that's still perfectly valid.
  const [treeLoading, setTreeLoading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const [saving, setSaving] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)
  const [conflictBusy, setConflictBusy] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [branchBusy, setBranchBusy] = useState(false)
  const [prompt, setPrompt] = useState<PromptSpec | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)

  const [configOpen, setConfigOpen] = useState(false)
  // Swaps the editor/preview split for a diff of the committed file against the
  // working copy. Sticky across file switches (like the wrap toggle), but only
  // *rendered* where there is a committed side to compare with — see `canDiff`.
  const [showDiff, setShowDiff] = useState(false)

  const [historyOpen, setHistoryOpen] = useState(false)
  // Path segment currently displayed — starts at the open file's path, but moves
  // to an older path once the user chooses to view history before a rename.
  const [historyPath, setHistoryPath] = useState<string | null>(null)
  const [historyPathStack, setHistoryPathStack] = useState<string[]>([])
  const [commits, setCommits] = useState<FileCommit[] | null>(null)
  const [historyPage, setHistoryPage] = useState(1)
  const [hasMoreCommits, setHasMoreCommits] = useState(false)
  const [loadingMoreCommits, setLoadingMoreCommits] = useState(false)
  const [renamedFrom, setRenamedFrom] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [versionContent, setVersionContent] = useState<string | null>(null)
  const [versionLoading, setVersionLoading] = useState(false)
  // How the selected version is shown, and — in diff mode — what it is compared
  // against. Both are sticky across selections: someone reading a file's history
  // as a series of diffs wants the next version to open the same way.
  const [historyView, setHistoryView] = useState<HistoryView>('preview')
  const [historyCompare, setHistoryCompare] = useState<HistoryCompare>('previous')
  /** Content of the version *before* the selected one, for the default diff. */
  const [previousContent, setPreviousContent] = useState<string | null>(null)
  const [previousLoading, setPreviousLoading] = useState(false)
  const [compareNote, setCompareNote] = useState<string | null>(null)

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

  // The theme dropdown, like layout, reflects and writes back the YAML config.
  // Show the matching preset if the config's palette matches one; "Custom" if it
  // has a palette matching none (hand-tuned); "None" if it sets no theme at all.
  const currentTheme = useMemo(() => {
    const matched = themeFromConfig(appliedConfig)
    if (matched) return matched.value
    const tv = appliedConfig?.themeVariables
    const hasVars = !!tv && typeof tv === 'object' && Object.keys(tv).length > 0
    return hasVars ? CUSTOM_THEME : NONE_THEME
  }, [appliedConfig])

  // Shared by the Select's onValueChange (commit) and each item's onFocus (live
  // preview as arrow keys/hover move the highlight), so navigating the dropdown
  // re-themes the diagram before the user settles on a choice.
  const applyTheme = useCallback(
    (v: string) => {
      if (v === CUSTOM_THEME) return
      const preset = v === NONE_THEME ? null : THEME_PRESETS.find((p) => p.value === v)
      if (v !== NONE_THEME && !preset) return
      updateConfig({ mermaidConfig: setThemeInYaml(config.mermaidConfig, preset ?? null) })
    },
    [config.mermaidConfig],
  )

  const repo = githubEnabled ? config.repo : null

  // Which editor the current document gets. For a repo file the extension decides;
  // with nothing open (local mode, or before picking a file) it's the user's
  // scratch choice. Everything else about a document — reading, committing,
  // drafts, conflicts, history — is identical across kinds; only the editing
  // surface and the export path differ.
  const kind: FileKind = openPath ? fileKind(openPath) : config.scratchKind

  // Excalidraw's theme is a binary light/dark switch, not an arbitrary palette,
  // so the canvas follows the *mode* of whichever diagram theme is active. That
  // keeps a scene from flashing a white canvas inside dark chrome when the user
  // opens it while a dark theme is selected.
  const canvasTheme = useMemo(() => resolveThemeMode(appliedConfig), [appliedConfig])

  // The canvas paints the active theme's background, so the drawing surface matches
  // the app chrome around it. Imposed for display only — never written to the file.
  const canvasBackground = useMemo(() => themeBackgroundColor(appliedConfig), [appliedConfig])

  // Mermaid files compare byte-for-byte, but scene JSON can't: re-serializing a
  // scene we just loaded legitimately changes the bytes (key order, the `source`
  // field, a renarrowed appState), so a freshly opened file would read as unsaved
  // before the user touched it. `scenesEqual` compares the drawing instead.
  const dirty =
    kind === 'excalidraw' ? !scenesEqual(text, baseline) : text !== baseline
  // Each scratch kind gets its own draft slot, so toggling between diagram,
  // document and canvas in local mode parks the current work rather than
  // overwriting it with content the other surface can't read.
  const scratchDocId = scratchDocIdFor(config.scratchKind)
  const docId =
    repo && openPath ? docIdForFile(repo.owner, repo.name, repo.branch, openPath) : scratchDocId

  // Keyed on the open document: edits within a file debounce, but switching files
  // takes effect at once so nothing downstream ever sees the outgoing file's text.
  const debouncedText = useDebouncedValue(text, 350, docId)
  // Export/download file name: the open file's name (folder + extension stripped).
  // Falls back to "diagram" only when nothing is open (local mode / fresh scratch).
  const baseName =
    (openPath ? (openPath.split('/').pop() ?? '').replace(/\.[^./]+$/, '') : '') || 'diagram'

  // A just-created file has no sha and isn't in the fetched tree yet; splice its
  // path in so it shows in the sidebar (flagged unsaved) before the first commit.
  const pendingPath = repo && openPath && loadedSha === null ? openPath : null

  // Every path with unsaved edits made *this session*, not just the open one —
  // so switching files without saving still shows the earlier file as dirty in
  // the tree. Keyed off the open file's live dirty state; committing, reverting,
  // deleting, or renaming a path removes it below.
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (!openPath) return
    setDirtyPaths((prev) => {
      if (dirty === prev.has(openPath)) return prev
      const next = new Set(prev)
      if (dirty) next.add(openPath)
      else next.delete(openPath)
      return next
    })
  }, [openPath, dirty])

  // Which directories are expanded in the file tree — kept in memory only (not
  // persisted), reset whenever the selected repo/branch changes so a stale
  // expand/collapse layout from the previous repo can't bleed into the next one.
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set())
  const onToggleDir = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const displayNodes = useMemo(() => {
    const base = tree?.tree ?? []
    if (!pendingPath) return base
    const paths = base.flatMap(collectFilePaths)
    if (!paths.includes(pendingPath)) paths.push(pendingPath)
    return buildTree(paths)
  }, [tree, pendingPath])

  // Flat list of every file in the repo, for completing markdown link targets in
  // the editor. Derived from the same tree the sidebar shows, so a file created or
  // deleted this session is offered (or stops being offered) without a new fetch.
  const repoFilePaths = useMemo(
    () => displayNodes.flatMap(collectFilePaths),
    [displayNodes],
  )

  const updateConfig = useCallback((patch: Partial<AppConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch }
      saveConfig(next)
      return next
    })
  }, [])

  /**
   * Fetch the tree and swap it in once it arrives.
   *
   * Deliberately does NOT clear `tree` first. Most callers are incidental
   * refreshes — after a commit, delete, rename, or the refresh button — where
   * blanking the list replaced it with a loading state for the duration of a round
   * trip, even though the list on screen was still almost entirely correct.
   *
   * Discarding the stale list is the caller's decision, and only two situations
   * warrant it: the very first load (where `tree` is already null) and a
   * repo/branch switch, where `resetForRepoSwitch` clears it because the paths
   * genuinely no longer apply.
   */
  const refreshTree = useCallback(async (target: RepoRef) => {
    setTreeLoading(true)
    setTreeError(null)
    const res = await listTree(
      target.owner,
      target.name,
      target.branch,
      target.branch === target.defaultBranch,
    )
    setTreeLoading(false)
    if (res.ok) {
      setTree(res.data)
      return res.data
    }
    if (handleExpiredSession(res.error)) return null
    // The connected repo is unreachable (uninstalled, access narrowed, renamed or
    // deleted). No retry fixes that and there is nothing to browse, so lead with
    // the picker — the same remedy as having no repo selected. `config.repo` is
    // deliberately left alone: the user may be mid-reinstall on GitHub, and
    // nulling it would throw away a selection that is about to work again.
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
      setOpenPath(null)
      setLoadedSha(null)
      const content = hasFiles ? '' : SAMPLE
      setText(content)
      setBaseline(content)
      // This content is mermaid source, so the scratch surface has to be the text
      // editor — otherwise a leftover canvas choice would try to parse it as a scene.
      updateConfig({ scratchKind: 'mermaid' })
    },
    [updateConfig],
  )

  // Invalidate everything scoped to the previously-selected repo/branch — called
  // synchronously before the new tree fetch even starts, so nothing from the old
  // repo (stale editor content, dirty markers, expanded folders) can linger if
  // that fetch is slow or fails.
  const resetForRepoSwitch = useCallback(() => {
    setOpenPath(null)
    setLoadedSha(null)
    setLinkTrail([])
    setText('')
    setBaseline('')
    setDirtyPaths(new Set())
    setExpandedPaths(new Set())
    // The outgoing repo/branch's paths are meaningless now, so this is one of the
    // few places the list *should* go back to a loading state.
    setTree(null)
    setTreeError(null)
    updateConfig({ scratchKind: 'mermaid' })
  }, [updateConfig])

  useEffect(() => {
    // `loginWithGitHub` redirects here with `?connect=1`, which marks this
    // arrival as a fresh sign-in: drop whatever repository was selected before so
    // the user always picks one after logging in (the auto-open effect below then
    // shows the picker). The flag is consumed and stripped from the URL right
    // away, so reloading the page afterwards keeps the new selection.
    const url = new URL(window.location.href)
    const freshLogin = githubEnabled && url.searchParams.get('connect') === '1'
    if (url.searchParams.has('connect')) {
      url.searchParams.delete('connect')
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }

    const loaded = loadConfig()
    const stored = freshLogin ? { ...loaded, repo: null } : loaded
    if (freshLogin) saveConfig(stored)
    setConfig(stored)
    setEditorRatio(stored.splitRatio)
    setSidebarWidth(stored.sidebarWidth)
    setHydrated(true)

    // A non-empty scratch draft is unsaved working-copy work — restore it across
    // reloads rather than clobbering it with the start state. Which slot to read
    // depends on the scratch surface the user last had open.
    const draft = loadDraft(scratchDocIdFor(stored.scratchKind))
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
  }, [githubEnabled, refreshTree, showRepoStartState])

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

  // The draft slot holds *divergence from the committed/starter state*, so it is
  // written only while the document is dirty and cleared as soon as it isn't.
  //
  // Saving unconditionally meant the auto-inserted starter template was itself
  // persisted as a draft the moment it was shown. That draft then won on every
  // subsequent load, so a user who had merely *looked* at a scratch document was
  // pinned to whatever the template said on that day — editing the template here
  // had no effect on them, forever. Gating on `dirty` also means committing,
  // restoring or reverting no longer leaves a redundant copy behind.
  useEffect(() => {
    if (!hydrated) return
    if (dirty) saveDraft(docId, debouncedText)
    else clearDraft(docId)
  }, [debouncedText, docId, hydrated, dirty])

  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

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

  const MIN_SIDEBAR_WIDTH = 180
  const MAX_SIDEBAR_WIDTH = 480

  const startSidebarDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = sidebarWidth
      const onMove = (ev: PointerEvent) => {
        const next = startWidth + (ev.clientX - startX)
        setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, next)))
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setSidebarWidth((w) => {
          updateConfig({ sidebarWidth: w })
          return w
        })
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [sidebarWidth, updateConfig],
  )

  const onSidebarDividerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 40 : 8
      let delta = 0
      if (e.key === 'ArrowLeft') delta = -step
      else if (e.key === 'ArrowRight') delta = step
      else return
      e.preventDefault()
      setSidebarWidth((w) => {
        const next = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w + delta))
        updateConfig({ sidebarWidth: next })
        return next
      })
    },
    [updateConfig],
  )

  /**
   * Switch the scratch document between the text editor and the canvas.
   *
   * Nothing is lost either way: the outgoing text is parked in its own draft slot
   * first, and the incoming kind's parked draft (if any) is restored. Only
   * meaningful with no file open — an open file's kind comes from its extension.
   */
  const switchScratchKind = useCallback(
    (nextKind: FileKind) => {
      if (openPath || nextKind === config.scratchKind) return
      saveDraft(scratchDocId, text)
      const parked = loadDraft(scratchDocIdFor(nextKind))
      const fresh = templateFor(nextKind)
      updateConfig({ scratchKind: nextKind })
      setText(parked && parked.content.trim().length > 0 ? parked.content : fresh)
      // Baseline is the pristine template, so a restored draft correctly reads as
      // unsaved work while a fresh switch reads as clean.
      setBaseline(fresh)
    },
    [openPath, config.scratchKind, scratchDocId, text, updateConfig],
  )

  const openPrompt = useCallback((spec: PromptSpec) => {
    setPrompt(spec)
    setPromptOpen(true)
  }, [])

  const onSelectRepo = useCallback(
    (r: Repo) => {
      const next: RepoRef = {
        owner: r.owner,
        name: r.name,
        defaultBranch: r.defaultBranch,
        branch: r.defaultBranch,
      }
      updateConfig({ repo: next })
      setRepoPickerOpen(false)
      resetForRepoSwitch()
      void refreshTree(next).then((data) => {
        if (data) showRepoStartState(data)
      })
    },
    [updateConfig, refreshTree, showRepoStartState, resetForRepoSwitch],
  )

  const onSelectBranch = useCallback(
    (branch: string) => {
      if (!repo) return
      const next: RepoRef = { ...repo, branch }
      updateConfig({ repo: next })
      setBranchPickerOpen(false)
      resetForRepoSwitch()
      void refreshTree(next).then((data) => {
        if (data) showRepoStartState(data)
      })
    },
    [repo, updateConfig, refreshTree, showRepoStartState, resetForRepoSwitch],
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
      onSelectBranch(name)
    },
    [repo, onSelectBranch],
  )

  const openFile = useCallback(
    async (path: string) => {
      if (!repo) return
      const res = await readFile(repo.owner, repo.name, path, repo.branch)
      if (!res.ok) {
        if (handleExpiredSession(res.error)) return
        toast.error(res.error.message)
        return
      }
      const id = docIdForFile(repo.owner, repo.name, repo.branch, path)
      const draft = loadDraft(id)
      setBaseline(res.data.content)
      setLoadedSha(res.data.sha)
      setOpenPath(path)
      // Only prefer the draft when it actually differs from what's committed. For
      // scenes that comparison has to be semantic: a draft the canvas wrote is in
      // canonical form and so rarely matches the committed bytes exactly, even
      // when it's the identical drawing.
      const draftDiffers =
        draft !== null &&
        (fileKind(path) === 'excalidraw'
          ? !scenesEqual(draft.content, res.data.content)
          : draft.content !== res.data.content)
      setText(draftDiffers && draft ? draft.content : res.data.content)
    },
    [repo],
  )

  /** Open a file the user picked from the tree — the start of a new trail. */
  const openFromTree = useCallback(
    (path: string) => {
      setLinkTrail([])
      void openFile(path)
    },
    [openFile],
  )

  /** Open a file by following a link inside the open document. */
  const openLinkedFile = useCallback(
    (path: string) => {
      if (path === openPath) return
      setLinkTrail((prev) => (openPath ? [...prev, openPath] : prev))
      void openFile(path)
    },
    [openFile, openPath],
  )

  const goBack = useCallback(() => {
    const target = linkTrail[linkTrail.length - 1]
    if (!target) return
    setLinkTrail(linkTrail.slice(0, -1))
    void openFile(target)
  }, [linkTrail, openFile])

  const newDiagram = useCallback(
    (dirPath?: string, newKind: FileKind = 'mermaid') => {
      if (!repo) {
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
        description: `Create a new file in ${dirPath || 'the repository root'} on ${repo.branch}.`,
        label: 'File name',
        defaultValue: 'untitled',
        prefix,
        suffix: extension,
        submitLabel: 'Start editing',
        validate: validateNewFilePath(extension),
        onSubmit: (path) => {
          setPromptOpen(false)
          setOpenPath(path)
          setLoadedSha(null)
          setBaseline('')
          setText(templateFor(fileKind(path)))
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
        description: `Move or rename this file on ${repo.branch}. Git history is preserved as a rename.`,
        label: 'New path',
        defaultValue: node.path,
        submitLabel: 'Rename',
        validate: validatePath,
        onSubmit: async (newPath) => {
          if (newPath === node.path) {
            setPromptOpen(false)
            return
          }
          const res = await renameFile(repo.owner, repo.name, node.path, newPath, repo.branch)
          if (!res.ok) {
            if (handleExpiredSession(res.error)) return
            toast.error(res.error.message)
            return
          }
          setPromptOpen(false)
          // Carry any uncommitted draft over to the new path.
          const oldId = docIdForFile(repo.owner, repo.name, repo.branch, node.path)
          const newId = docIdForFile(repo.owner, repo.name, repo.branch, newPath)
          const draft = loadDraft(oldId)
          if (draft) saveDraft(newId, draft.content)
          clearDraft(oldId)
          setDirtyPaths((prev) => {
            if (!prev.has(node.path)) return prev
            const next = new Set(prev)
            next.delete(node.path)
            next.add(newPath)
            return next
          })
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
    setLinkTrail([])
    updateConfig({ scratchKind: 'mermaid' })
  }, [docId, updateConfig])

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
      setDirtyPaths((prev) => withoutPaths(prev, paths))
      setDeleteOpen(false)
      setDeleteTarget(null)
      return
    }
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
    setDirtyPaths((prev) => withoutPaths(prev, paths))
    setDeleteOpen(false)
    setDeleteTarget(null)
    if (affectsOpen) detachEditor()
    void refreshTree(repo)
  }, [repo, deleteTarget, pendingPath, openPath, detachEditor, refreshTree])

  const commitCurrent = useCallback(
    async (path: string, sha: string | undefined, content: string) => {
      if (!repo) return
      setSaving(true)
      const res = await commitFile(repo.owner, repo.name, path, content, repo.branch, sha)
      setSaving(false)
      if (res.ok) {
        setBaseline(content)
        setLoadedSha(res.data.sha)
        setOpenPath(path)
        // Committing an untitled scratch document promotes it to a real file, so
        // its parked draft is spent — clear the slot for the kind it came from,
        // not just the mermaid one.
        clearDraft(scratchDocId)
        toast.success(`Committed ${path}`)
        void refreshTree(repo)
        return
      }
      if (handleExpiredSession(res.error)) return
      if (res.error.kind === 'conflict') setConflictOpen(true)
      else toast.error(res.error.message)
    },
    [repo, refreshTree, scratchDocId],
  )

  const onSave = useCallback(() => {
    if (!repo || !dirty || saving) return
    if (openPath === null) {
      openPrompt({
        title: 'Save to repository',
        description: `Choose a path on ${repo.branch} for this document.`,
        label: 'File path',
        defaultValue: defaultFileName(kind, 'untitled'),
        submitLabel: 'Save',
        validate: validatePathForKind(kind),
        onSubmit: (path) => {
          setPromptOpen(false)
          void commitCurrent(path, undefined, text)
        },
      })
      return
    }
    void commitCurrent(openPath, loadedSha ?? undefined, text)
  }, [repo, dirty, saving, openPath, loadedSha, text, kind, commitCurrent, openPrompt])

  // Discard uncommitted edits, resetting the editor back to the last-loaded
  // commit. Only meaningful once there is an actual commit to fall back to
  // (loadedSha !== null) — a never-committed file has no "last commit" state.
  const canRestore = dirty && loadedSha !== null
  const onRestore = useCallback(() => {
    if (!canRestore) return
    setText(baseline)
    clearDraft(docId)
  }, [canRestore, baseline, docId])

  // Detect the platform for the correct modifier label (⌘ vs Ctrl).
  useEffect(() => {
    setIsMac(/mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent))
  }, [])

  // Keyboard shortcuts (only when GitHub repo features are active): ⌘/Ctrl+S
  // saves; ⌘/Ctrl+Alt+N starts a new diagram. New-diagram uses Alt because
  // browsers reserve plain ⌘/Ctrl+N (new window) and won't let a page cancel it.
  // `e.code` (physical key) is used so macOS Option+N (a dead key) still matches.
  // ⌘/Ctrl+B toggles the file-tree sidebar (only meaningful once a repo is open).
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
      } else if (e.code === 'KeyB' && !e.altKey && repo) {
        e.preventDefault()
        setSidebarOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [githubEnabled, onSave, newDiagram, repo])

  const onOverwrite = useCallback(async () => {
    if (!repo || !openPath) return
    setConflictBusy(true)
    const fresh = await readFile(repo.owner, repo.name, openPath, repo.branch)
    if (!fresh.ok) {
      setConflictBusy(false)
      if (handleExpiredSession(fresh.error)) return
      toast.error(fresh.error.message)
      return
    }
    const res = await commitFile(repo.owner, repo.name, openPath, text, repo.branch, fresh.data.sha)
    setConflictBusy(false)
    if (res.ok) {
      setBaseline(text)
      setLoadedSha(res.data.sha)
      setConflictOpen(false)
      clearDraft(docId)
      toast.success('Overwritten on top of latest')
      void refreshTree(repo)
    } else if (!handleExpiredSession(res.error)) {
      toast.error(res.error.message)
    }
  }, [repo, openPath, text, docId, refreshTree])

  const onStartOver = useCallback(async () => {
    if (!repo || !openPath) return
    setConflictBusy(true)
    const fresh = await readFile(repo.owner, repo.name, openPath, repo.branch)
    setConflictBusy(false)
    if (!fresh.ok) {
      if (handleExpiredSession(fresh.error)) return
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
      // The comparison base belongs to the previously selected version.
      setPreviousContent(null)
      setCompareNote(null)
      // Use the path the file had at that commit (may differ across renames).
      const res = await readFileAtRef(repo.owner, repo.name, commit.path, commit.sha)
      setVersionLoading(false)
      if (res.ok) setVersionContent(res.data)
      else if (!handleExpiredSession(res.error)) setHistoryError(res.error.message)
    },
    [repo],
  )

  const HISTORY_PAGE_SIZE = 30

  // Loads one page of history for `path`; `append` decides whether it extends the
  // current list (Load more) or replaces it (first load / jump to another path).
  const loadHistoryPage = useCallback(
    async (path: string, page: number, append: boolean) => {
      if (!repo) return
      const res = await listFileCommits(
        repo.owner,
        repo.name,
        path,
        repo.branch,
        page,
        HISTORY_PAGE_SIZE,
      )
      if (!res.ok) {
        if (!handleExpiredSession(res.error)) setHistoryError(res.error.message)
        return
      }
      setCommits((prev) => (append && prev ? [...prev, ...res.data.commits] : res.data.commits))
      setHistoryPage(page)
      setHasMoreCommits(res.data.hasMore)
      setRenamedFrom(res.data.renamedFrom)
      // Preselect the latest version on a fresh load only.
      if (!append && res.data.commits[0]) void selectVersion(res.data.commits[0])
    },
    [repo, selectVersion],
  )

  const openHistory = useCallback(async () => {
    if (!repo || !openPath) return
    setHistoryOpen(true)
    setHistoryPath(openPath)
    setHistoryPathStack([])
    setCommits(null)
    setHistoryError(null)
    setSelectedSha(null)
    setVersionContent(null)
    setHasMoreCommits(false)
    setRenamedFrom(null)
    await loadHistoryPage(openPath, 1, false)
  }, [repo, openPath, loadHistoryPage])

  const loadMoreCommits = useCallback(async () => {
    if (!historyPath || loadingMoreCommits) return
    setLoadingMoreCommits(true)
    await loadHistoryPage(historyPath, historyPage + 1, true)
    setLoadingMoreCommits(false)
  }, [historyPath, historyPage, loadingMoreCommits, loadHistoryPage])

  const viewHistoryBeforeRename = useCallback(async () => {
    if (!historyPath || !renamedFrom) return
    setHistoryPathStack((prev) => [...prev, historyPath])
    setHistoryPath(renamedFrom)
    setCommits(null)
    setHasMoreCommits(false)
    setRenamedFrom(null)
    setHistoryError(null)
    await loadHistoryPage(renamedFrom, 1, false)
  }, [historyPath, renamedFrom, loadHistoryPage])

  const goBackHistory = useCallback(async () => {
    if (historyPathStack.length === 0) return
    const next = historyPathStack.slice(0, -1)
    const target = historyPathStack[historyPathStack.length - 1]!
    setHistoryPathStack(next)
    setHistoryPath(target)
    setCommits(null)
    setHasMoreCommits(false)
    setRenamedFrom(null)
    setHistoryError(null)
    await loadHistoryPage(target, 1, false)
  }, [historyPathStack, loadHistoryPage])

  // The commit immediately older than the selected one, among those loaded. A
  // file's history is paged, so "no older commit here" can mean either "this is
  // the first commit" or "the next page hasn't been fetched yet" — which the
  // effect below has to tell apart before claiming the file was created here.
  const olderCommit = useMemo(() => {
    if (!commits || !selectedSha) return null
    const index = commits.findIndex((c) => c.sha === selectedSha)
    return index >= 0 ? (commits[index + 1] ?? null) : null
  }, [commits, selectedSha])

  const selectedIsOldestLoaded = useMemo(() => {
    if (!commits || !selectedSha) return false
    const index = commits.findIndex((c) => c.sha === selectedSha)
    return index >= 0 && index === commits.length - 1
  }, [commits, selectedSha])

  // Fetch the previous version's content — only while a diff against it is
  // actually on screen, so browsing history in preview mode costs nothing extra.
  useEffect(() => {
    if (!historyOpen || historyView !== 'diff' || historyCompare !== 'previous') return
    if (!repo || !selectedSha) return
    if (!olderCommit) {
      if (selectedIsOldestLoaded && (hasMoreCommits || renamedFrom)) {
        setPreviousContent(null)
        setCompareNote(
          'Load more history to compare this version with the one before it.',
        )
      } else {
        // Genuinely the first commit of this path: everything in it is new.
        setPreviousContent('')
        setCompareNote(null)
      }
      return
    }
    let cancelled = false
    setCompareNote(null)
    setPreviousLoading(true)
    void readFileAtRef(repo.owner, repo.name, olderCommit.path, olderCommit.sha).then((res) => {
      if (cancelled) return
      setPreviousLoading(false)
      if (res.ok) setPreviousContent(res.data)
      else if (!handleExpiredSession(res.error)) setCompareNote(res.error.message)
    })
    return () => {
      cancelled = true
    }
  }, [
    historyOpen,
    historyView,
    historyCompare,
    repo,
    selectedSha,
    olderCommit,
    selectedIsOldestLoaded,
    hasMoreCommits,
    renamedFrom,
  ])

  // The two sides of the history diff. Comparing with the previous version reads
  // forwards (older → this version, i.e. what the commit changed); comparing with
  // the working copy reads the other way round, since the working copy is the
  // newer of the two.
  const historyDiff = useMemo(() => {
    if (historyView !== 'diff' || versionContent === null) return null
    if (historyCompare === 'working') return { before: versionContent, after: text }
    if (previousContent === null) return null
    return { before: previousContent, after: versionContent }
  }, [historyView, historyCompare, versionContent, previousContent, text])

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
  }, [versionContent, repo, kind, openPrompt])

  const canSave = !!repo && dirty && text.trim().length > 0 && !saving
  // A canvas has no text to diff, and a file with no commit behind it has nothing
  // to diff against.
  const canDiff = kind !== 'excalidraw' && loadedSha !== null
  const showSidebar = githubEnabled && !!repo && sidebarOpen
  const saveHint = isMac ? '⌘ S' : 'Ctrl + S'
  const newHint = isMac ? '⌥ ⌘ N' : 'Ctrl + Alt + N'
  const sidebarHint = isMac ? '⌘ B' : 'Ctrl + B'

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex flex-none items-center justify-between gap-4 border-b bg-card px-4 py-2">
        <div className="flex items-center gap-2">
          {githubEnabled && repo ? (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setSidebarOpen((v) => !v)}
              title={`${sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'} (${sidebarHint})`}
            >
              <PanelLeft />
            </Button>
          ) : null}
          <Link href="/" className="text-xl font-bold hover:text-primary">
            {APP_NAME}
          </Link>
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
          {githubEnabled && repo ? (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              onClick={() => setBranchPickerOpen(true)}
            >
              <GitBranch /> {repo.branch}
            </Button>
          ) : null}
          {githubEnabled && repo && repo.defaultBranch && repo.branch !== repo.defaultBranch ? (
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
          {githubEnabled ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={onRestore}
                disabled={!canRestore}
                title="Restore to last commit"
              >
                <RotateCcw /> Restore
              </Button>
              <Button size="sm" onClick={onSave} disabled={!canSave} title={`Commit (${saveHint})`}>
                {saving ? 'Committing…' : 'Commit'}
                <kbd className="ml-1 flex items-center gap-0.5 rounded border border-current/30 px-1 text-[10px] leading-none font-medium opacity-70">
                  {isMac ? (
                    <>
                      <Command className="size-2.5" /> <span>S</span>
                    </>
                  ) : (
                    <span>Ctrl + S</span>
                  )}
                </kbd>
              </Button>
              <span className="text-xs text-muted-foreground">
                {dirty ? '● Unsaved' : 'Saved'}
              </span>
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
            configYaml={config.mermaidConfig}
            background={config.exportBackground}
            onBackgroundChange={(v) => updateConfig({ exportBackground: v })}
            config={appliedConfig}
            kind={kind}
          />
          <Separator orientation="vertical" className="h-6" />
          <AuthButton user={user} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {showSidebar ? (
          <aside
            className="flex flex-none flex-col overflow-hidden bg-sidebar"
            style={{ width: sidebarWidth }}
          >
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
                Files
                {dirtyPaths.size > 0 ? (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-amber-500"
                    title={`${dirtyPaths.size} unsaved file${dirtyPaths.size === 1 ? '' : 's'}`}
                    aria-label={`${dirtyPaths.size} unsaved file${dirtyPaths.size === 1 ? '' : 's'}`}
                  />
                ) : null}
              </span>
              <div className="flex items-center gap-0.5">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => repo && void refreshTree(repo)}
                  disabled={!repo || treeLoading}
                  title="Refresh files"
                >
                  <RefreshCw className={cn(treeLoading && 'animate-spin')} />
                </Button>
                <NewFileMenu onSelect={(k) => newDiagram(undefined, k)}>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title={`New file at root (${newHint})`}
                  >
                    <Plus />
                  </Button>
                </NewFileMenu>
              </div>
            </div>
            <Separator />
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {tree?.truncated ? (
                <p className="mb-2 rounded-md bg-muted p-2 text-xs text-muted-foreground">
                  ⚠ Large repo; some files may be hidden.
                </p>
              ) : null}
              {/* A refresh that fails while a list is already on screen shows the
                  error as a banner and keeps the list — the stale list is far more
                  useful than an empty pane, and the next refresh clears this. */}
              {treeError && tree !== null ? (
                <p className="mb-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                  {treeError}
                </p>
              ) : null}
              {treeError && tree === null ? (
                <p className="p-2 text-sm text-destructive">{treeError}</p>
              ) : tree === null ? (
                <FileTreeSkeleton />
              ) : (
                <FileTree
                  nodes={displayNodes}
                  activePath={openPath}
                  dirtyPaths={dirtyPaths}
                  expandedPaths={expandedPaths}
                  onToggleDir={onToggleDir}
                  branch={repo?.branch ?? ''}
                  onOpenFile={openFromTree}
                  onDelete={requestDelete}
                  onNewFile={(dir, k) => newDiagram(dir, k)}
                  onRename={requestRename}
                />
              )}
            </div>
          </aside>
        ) : null}
        {showSidebar ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            onPointerDown={startSidebarDrag}
            onKeyDown={onSidebarDividerKeyDown}
            className="group flex w-1.5 flex-none cursor-col-resize touch-none items-center justify-center bg-border transition-colors hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none"
          >
            <div className="h-8 w-0.5 rounded-full bg-muted-foreground/40 transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
          </div>
        ) : null}

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-none flex-wrap items-center gap-1.5 border-b px-3 py-2 text-xs text-muted-foreground">
            {githubEnabled && repo && linkTrail.length > 0 ? (
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={goBack}
                title={`Back to ${linkTrail[linkTrail.length - 1]}`}
                aria-label={`Back to ${linkTrail[linkTrail.length - 1]}`}
              >
                <ArrowLeft />
              </Button>
            ) : null}
            {githubEnabled && repo ? (
              <span>{openPath ?? 'untitled (unsaved local draft)'}</span>
            ) : githubEnabled ? (
              <span>Connect a repository to browse and commit your diagrams.</span>
            ) : (
              <span>Local mode — edits stay in your browser (localStorage).</span>
            )}
            {/* With no file open there's no extension to infer from, so the user
                picks the surface. Each kind keeps its own draft, so toggling is
                non-destructive.

                Deliberately on the LEFT, outside the `ml-auto` group: it only
                exists while no file is open, and inside that group its appearing
                and disappearing shunted the theme and layout controls sideways
                every time a file was opened or closed. */}
            {!openPath ? (
              <div className="ml-1 flex items-center gap-0.5 rounded-md border p-0.5">
                {/* Same order as NewFileMenu: markdown first. */}
                <Button
                  size="sm"
                  variant={kind === 'markdown' ? 'secondary' : 'ghost'}
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={() => switchScratchKind('markdown')}
                >
                  <MarkdownIcon className="size-3" /> Markdown
                </Button>
                <Button
                  size="sm"
                  variant={kind === 'mermaid' ? 'secondary' : 'ghost'}
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={() => switchScratchKind('mermaid')}
                >
                  <MermaidIcon className="size-3" /> Diagram
                </Button>
                <Button
                  size="sm"
                  variant={kind === 'excalidraw' ? 'secondary' : 'ghost'}
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={() => switchScratchKind('excalidraw')}
                >
                  <ExcalidrawIcon className="size-3" /> Canvas
                </Button>
              </div>
            ) : null}
            <div className="ml-auto flex items-center gap-1.5">
              {/* Editor-only control, so it disappears with the canvas — which has
                  no lines to wrap. */}
              {kind !== 'excalidraw' ? (
                <Button
                  size="icon-sm"
                  variant={showDiff && canDiff ? 'secondary' : 'ghost'}
                  className="size-7"
                  onClick={() => setShowDiff((v) => !v)}
                  disabled={!canDiff}
                  aria-pressed={showDiff && canDiff}
                  aria-label="Compare with the last commit"
                  title={
                    canDiff
                      ? showDiff
                        ? 'Back to the editor'
                        : 'Compare with the last commit'
                      : 'Nothing committed yet to compare with'
                  }
                >
                  <FileDiff />
                </Button>
              ) : null}
              {kind !== 'excalidraw' ? (
                <Button
                  size="icon-sm"
                  variant={config.wrapLines ? 'secondary' : 'ghost'}
                  className="size-7"
                  onClick={() => updateConfig({ wrapLines: !config.wrapLines })}
                  aria-pressed={config.wrapLines}
                  aria-label="Wrap long lines"
                  title={config.wrapLines ? 'Wrap long lines: on' : 'Wrap long lines: off'}
                >
                  <WrapText />
                </Button>
              ) : null}
              {kind !== 'excalidraw' ? (
                <Button
                  size="icon-sm"
                  variant={config.minimap ? 'secondary' : 'ghost'}
                  className="size-7"
                  onClick={() => updateConfig({ minimap: !config.minimap })}
                  aria-pressed={config.minimap}
                  aria-label="Viewfinder"
                  title={config.minimap ? 'Viewfinder: on' : 'Viewfinder: off'}
                >
                  <Map />
                </Button>
              ) : null}
              <span className="text-muted-foreground">Theme</span>
              <Select value={currentTheme} onValueChange={applyTheme}>
                <SelectTrigger size="sm" className="h-7 w-48" aria-label="Diagram theme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem
                    value={NONE_THEME}
                    className="cursor-pointer"
                    onFocus={() => applyTheme(NONE_THEME)}
                  >
                    None (default)
                  </SelectItem>
                  {currentTheme === CUSTOM_THEME ? (
                    <SelectItem value={CUSTOM_THEME} disabled>
                      Custom
                    </SelectItem>
                  ) : null}
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Light</SelectLabel>
                    {THEME_PRESETS.filter((preset) => preset.mode === 'light').map((preset) => (
                      <SelectItem
                        key={preset.value}
                        value={preset.value}
                        className="cursor-pointer"
                        onFocus={() => applyTheme(preset.value)}
                      >
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel>Dark</SelectLabel>
                    {THEME_PRESETS.filter((preset) => preset.mode === 'dark').map((preset) => (
                      <SelectItem
                        key={preset.value}
                        value={preset.value}
                        className="cursor-pointer"
                        onFocus={() => applyTheme(preset.value)}
                      >
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {/* Layout engine and the mermaid YAML config have no meaning for a
                  canvas. The Theme dropdown above stays, because it still recolors
                  the app chrome — and drives the canvas's light/dark mode.
                  Markdown keeps both: they drive its embedded ```mermaid fences. */}
              {kind !== 'excalidraw' ? (
                <>
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
                </>
              ) : null}
            </div>
          </div>

          {kind === 'excalidraw' ? (
            // A canvas is its own editor *and* its own preview, so it takes the
            // full pane — no split, no divider. `key` remounts it per file so one
            // document's undo history and scroll position can't leak into the next.
            <section className="min-h-0 flex-1" aria-label="Canvas">
              <Canvas
                key={openPath ?? 'scratch'}
                value={text}
                onChange={setText}
                theme={canvasTheme}
                backgroundColor={canvasBackground}
              />
            </section>
          ) : showDiff && canDiff ? (
            // The diff takes the whole pane row: side by side needs the width, and
            // there is nothing to edit while reading it.
            <section className="min-h-0 flex-1 overflow-auto" aria-label="Uncommitted changes">
              <DiffView
                before={baseline}
                after={debouncedText}
                beforeLabel="Last commit"
                afterLabel="Working copy"
                emptyMessage="No uncommitted changes — this document matches the last commit."
              />
            </section>
          ) : (
            <div
              ref={paneRowRef}
              className="grid min-h-0 flex-1"
              style={{
                gridTemplateColumns: `minmax(0,${editorRatio}fr) 6px minmax(0,${1 - editorRatio}fr)`,
              }}
            >
              <section className="min-h-0 overflow-auto" aria-label="Editor">
                <Editor
                  value={text}
                  onChange={setText}
                  dark={false}
                  kind={kind}
                  wrap={config.wrapLines}
                  // Only a committed file has something to diverge *from*; a new
                  // file (or the local scratch document) would otherwise show
                  // every one of its lines as added.
                  baseline={loadedSha !== null ? baseline : null}
                  filePaths={repoFilePaths}
                  docPath={openPath}
                  minimap={config.minimap}
                />
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
                {kind === 'markdown' ? (
                  <MarkdownPreview
                    text={debouncedText}
                    config={appliedConfig}
                    path={openPath}
                    repo={repo}
                    onOpenFile={repo ? openLinkedFile : undefined}
                    // Filling the window hides the toolbar's Back button, so the
                    // reading view carries its own.
                    onBack={linkTrail.length > 0 ? goBack : undefined}
                    backLabel={linkTrail[linkTrail.length - 1]}
                  />
                ) : (
                  <Preview text={debouncedText} config={appliedConfig} />
                )}
              </section>
            </div>
          )}
        </main>
      </div>

      {githubEnabled ? (
        <RepoPicker
          open={repoPickerOpen}
          onOpenChange={setRepoPickerOpen}
          onSelect={onSelectRepo}
        />
      ) : null}

      {githubEnabled && repo ? (
        <BranchPicker
          open={branchPickerOpen}
          onOpenChange={setBranchPickerOpen}
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
          onOpenChange={setConflictOpen}
          path={openPath}
          branch={repo?.branch ?? ''}
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
        branch={repo?.branch ?? ''}
        busy={deleteBusy}
        onConfirm={confirmDelete}
      />

      {openPath ? (
        <HistoryPanel
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          path={openPath}
          historyPath={historyPath ?? openPath}
          commits={commits}
          error={historyError}
          hasMore={hasMoreCommits}
          loadingMore={loadingMoreCommits}
          renamedFrom={renamedFrom}
          canGoBack={historyPathStack.length > 0}
          selectedSha={selectedSha}
          versionContent={versionContent}
          versionLoading={versionLoading}
          config={appliedConfig}
          kind={kind}
          canvasTheme={canvasTheme}
          canvasBackground={canvasBackground}
          view={historyView}
          onViewChange={setHistoryView}
          compare={historyCompare}
          onCompareChange={setHistoryCompare}
          diff={historyDiff}
          diffLoading={previousLoading}
          diffNote={compareNote}
          onSelect={selectVersion}
          onLoadMore={loadMoreCommits}
          onViewBeforeRename={viewHistoryBeforeRename}
          onBack={goBackHistory}
          onRecover={onRecover}
          onFork={onFork}
        />
      ) : null}

      <MobileWarningModal
        open={mobileWarningOpen}
        onOpenChange={(open) => {
          setMobileWarningOpen(open)
          if (!open) setMobileWarningDismissed(true)
        }}
      />
    </div>
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
 * The create prompt's validation. The extension is supplied by the prompt itself,
 * so the only new failure mode is an empty name — which would otherwise assemble
 * into a dotfile (`docs/.md`) that `validatePath` happily accepts.
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
 * Requires an extension matching `kind` — used when an *existing* document is
 * written to a new path (save-as, fork from history). The content's kind is
 * already fixed there, so a mismatched extension would commit, say, mermaid
 * source into a `.excalidraw` file that then opens as a broken canvas.
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
