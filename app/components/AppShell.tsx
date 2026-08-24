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
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  WrapText,
} from 'lucide-react'
import { toast } from 'sonner'
import Editor, { type EditorHandle } from './Editor'
import Preview from './Preview'
import MarkdownPreview, { type MarkdownPreviewHandle } from './MarkdownPreview'
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
import AgentLinkModal from './AgentLinkModal'
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
import { useAgentLink, type AgentLinkCapabilities } from '@/lib/agentLink'
import { normalizeMcpOrigin } from '@/lib/mcpOrigin'
import type { BridgeState } from '@/lib/agentProtocol'
import { collectDiagnostics } from '@/lib/diagnostics'
import { ensureExcalidrawFonts } from '@/lib/excalidrawFonts'
import { applySceneOps, summarizeScene } from '@/lib/sceneEdit'
import { applyResolved, resolveEdits } from '@/lib/textEdit'
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
  loadAgentLink,
  loadConfig,
  saveAgentLink,
  saveConfig,
  loadDraft,
  saveDraft,
  clearDraft,
  docIdForFile,
  docIdForLocalFile,
  scratchDocIdFor,
  listDraftPaths,
  listLocalDraftPaths,
  listLocalFiles,
  readLocalFile,
  writeLocalFile,
  deleteLocalFile,
  renameLocalFile,
} from '@/lib/storage'
import { APP_NAME, DEFAULT_MCP_ORIGIN } from '@/lib/config'
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

/**
 * Whether two versions of the same document differ.
 *
 * Scenes cannot be compared byte-for-byte (rule 9): re-serializing a scene we just
 * loaded legitimately changes the bytes — key order, the `source` field, a
 * renarrowed appState — so a freshly opened file would read as unsaved before
 * anybody touched it. `scenesEqual` compares the drawing instead.
 *
 * Every dirty decision in this file goes through here, including the ones an agent
 * makes about a file nobody has opened. They have to agree: one of them lights the
 * dot in the sidebar and another decides whether a draft is kept, and a disagreement
 * means a file marked unsaved with nothing saved in it.
 */
function contentDiffers(a: string, b: string, kind: FileKind): boolean {
  return kind === 'excalidraw' ? !scenesEqual(a, b) : a !== b
}

/**
 * What `loadedSha` holds for a saved *local* file.
 *
 * `loadedSha` has always answered two questions at once — "which commit is this"
 * and "is there a saved version behind this document at all" — and only the first
 * is about GitHub. Local mode needs the second: Restore, the diff gutter, DiffView
 * and `pendingPaths` all key on `loadedSha !== null`, and every one of them is
 * right in local mode for the same reason it is right in a repo. A sentinel keeps
 * those four working untouched, and it can never be mistaken for a real sha, which
 * is a 40-character hex string.
 */
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

/**
 * The fetched tree with `path` spliced in as a committed file.
 *
 * Called the moment a commit lands, because the commit itself is what makes a
 * never-committed file stop being pending — and `pendingPaths` is what was
 * splicing it into the sidebar. Waiting for `refreshTree` to prove the path is on
 * the branch leaves a gap of one round trip in which the file belongs to neither
 * set, and it blinked out of the tree and back for exactly that long.
 *
 * Recording it as *committed* rather than keeping it pending is the point: a
 * pending path routes reads at the localStorage draft (which the commit just
 * spent) and sends rename/delete down the local-only branch that skips GitHub.
 * The path is genuinely on the branch now, so the optimistic entry says so, and
 * the real fetch overwrites it either way.
 */
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
    mcpOrigin: null,
    mermaidConfig: '',
  })
  const [hydrated, setHydrated] = useState(false)

  /** Agent Link, scoped to *this tab* rather than to the origin — see
   *  `loadAgentLink`. Kept out of `AppConfig` on purpose: a shared switch armed
   *  every tab at once, so the human could not choose which one an agent drove.
   *
   *  Starts off and is hydrated in an effect, like the rest of the persisted
   *  state: `sessionStorage` does not exist during SSR, and reading it in the
   *  initializer would make the server and client renders disagree. */
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

  // Excalidraw's scene fonts, registered on page load rather than when a canvas
  // mounts.
  //
  // Deliberately unconditional — not gated on the open document being a canvas, and
  // not deferred to the first scene edit. An agent's `scene_edit` can arrive at any
  // moment for a file nobody is looking at, and the whole point of registering these
  // ourselves is that the measurement no longer depends on what is on screen. Costs a
  // 1.3KB manifest and 21 `FontFace` objects; the woff2 files stay unfetched until
  // something is actually measured against them, so this is not the ~1MB editor
  // bundle by another route (rule 8). Fire and forget: `applySceneOps` awaits the same
  // promise, so an edit that beats the warm-up waits for it rather than racing it.
  useEffect(() => {
    void ensureExcalidrawFonts()
  }, [])

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
  const [linkOpen, setLinkOpen] = useState(false)
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

  /**
   * Local mode: no GitHub, and localStorage holds the saved files as well as the
   * drafts over them.
   *
   * The two modes are deliberately *one* file lifecycle with two backing stores,
   * not two features. Everything below that reads or writes a document asks which
   * store it is talking to and nothing else changes — which is why the diff gutter,
   * the dirty markers, Restore, and the agent's path resolution all work in local
   * mode without a line of their own.
   */
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
  const refreshLocalFiles = useCallback(() => {
    setLocalPaths(listLocalFiles())
  }, [])

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
  /** CodeMirror carries its own binary `dark` flag, which decides the defaults for
   *  every surface `editorTheme` doesn't name. It follows the same resolved mode
   *  as the canvas — pinned to `false`, a dark palette got CodeMirror's
   *  light-theme defaults underneath it. */
  const editorDark = canvasTheme === 'dark'

  // The canvas paints the active theme's background, so the drawing surface matches
  // the app chrome around it. Imposed for display only — never written to the file.
  const canvasBackground = useMemo(() => themeBackgroundColor(appliedConfig), [appliedConfig])

  const dirty = contentDiffers(text, baseline, kind)
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

  // Keyed on the open document: edits within a file debounce, but switching files
  // takes effect at once so nothing downstream ever sees the outgoing file's text.
  const debouncedText = useDebouncedValue(text, 350, docId)
  // Export/download file name: the open file's name (folder + extension stripped).
  // Falls back to "diagram" only when nothing is open (local mode / fresh scratch).
  const baseName =
    (openPath ? (openPath.split('/').pop() ?? '').replace(/\.[^./]+$/, '') : '') || 'diagram'

  /**
   * Files that exist only in this browser: created here, never committed, so the
   * fetched tree has no entry for them and GitHub has nothing under the path.
   * They're spliced into the sidebar below and their content is a localStorage
   * draft.
   *
   * This has to be a *set*, and it has to outlive the file being open. Derived
   * from `openPath` alone — which it was — creating a second file, or opening any
   * other file, dropped the first one out of the sidebar while its draft stayed in
   * localStorage with nothing left able to reach it: the file appeared to vanish.
   * Cleared on commit (it's a real path then), on delete, and on a repo/branch
   * switch; moved by a local rename.
   */
  const [createdPaths, setCreatedPaths] = useState<ReadonlySet<string>>(new Set())

  // Every never-committed path, as the rest of the app should see it: anything in
  // `createdPaths` the branch still doesn't have, plus the open file whenever it
  // has no sha behind it. Filtering against the fetched tree means a path that got
  // committed (here or in another tab) stops being pending on the next refresh,
  // whether or not something remembered to remove it.
  /**
   * Every path that genuinely exists in the saved store: on the branch in GitHub
   * mode, in localStorage in local mode.
   *
   * Null until that store has been read, which is *not* the same as empty and the
   * difference is load-bearing: against an empty set every path an agent names
   * looks like one it should create, so a command arriving before the first tree
   * fetch would write files over paths that already exist.
   */
  const savedPaths = useMemo<ReadonlySet<string> | null>(() => {
    if (localMode) return localPaths === null ? null : new Set(localPaths)
    return tree ? new Set(tree.tree.flatMap(collectFilePaths)) : null
  }, [localMode, localPaths, tree])

  const pendingPaths = useMemo<ReadonlySet<string>>(() => {
    const next = new Set<string>()
    for (const path of createdPaths) if (!savedPaths?.has(path)) next.add(path)
    if (hasWorkspace && openPath && loadedSha === null) next.add(openPath)
    return next
  }, [savedPaths, createdPaths, hasWorkspace, openPath, loadedSha])

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
    const base = localMode ? buildTree([...(localPaths ?? [])]) : (tree?.tree ?? [])
    if (pendingPaths.size === 0) return base
    const paths = base.flatMap(collectFilePaths)
    for (const path of pendingPaths) if (!paths.includes(path)) paths.push(path)
    return buildTree(paths)
  }, [localMode, localPaths, tree, pendingPaths])

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
    setCreatedPaths(new Set())
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
    setAgentLinkOn(loadAgentLink())
    setHydrated(true)
    // The local store is the file system in local mode, so read it now rather than
    // leave `localPaths` null — every "does this file exist" question below waits on
    // it, the agent's included.
    if (!githubEnabled) setLocalPaths(listLocalFiles())

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

  /**
   * Recover never-saved files across a reload. Neither `openPath` nor `createdPaths`
   * is persisted, so after a refresh nothing remembers them — but their drafts are
   * still in localStorage, and a draft under a path the saved store doesn't have can
   * only be a file created here and never saved.
   *
   * Deliberately **once per workspace**, on its first file list, rather than on
   * every refresh. A rename or a commit moves a draft before the tree that proves
   * where the path now lives has arrived, so re-deriving this against a stale tree
   * would briefly re-flag a path that is in fact committed — and while it is
   * flagged, rename and delete would take their never-saved branch and skip GitHub.
   */
  const recoveredFor = useRef<string | null>(null)
  useEffect(() => {
    if (!hasWorkspace || !savedPaths) return
    const key = repo ? docIdForFile(repo.owner, repo.name, repo.branch, '') : 'local'
    if (recoveredFor.current === key) return
    recoveredFor.current = key
    const committed = savedPaths
    const drafts = repo
      ? listDraftPaths(repo.owner, repo.name, repo.branch)
      : listLocalDraftPaths()
    if (drafts.length === 0) return
    // A draft is only ever written while a document is dirty and is cleared the
    // moment it isn't, so a draft under this branch *is* a file with uncommitted
    // edits — light its marker in the sidebar. Without this the markers lived only
    // as long as the tab: an agent that edited six files nobody opened left the
    // work in localStorage and no sign of it anywhere on screen after a reload.
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
  }, [hasWorkspace, savedPaths, repo])

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

  /**
   * The saved copy of `path`: the committed file on the branch, or the local file
   * in localStorage.
   *
   * One reader for both stores, because three callers need it — opening a file, the
   * agent resolving a path, and version history's compare — and a second spelling
   * of "which store am I in" is a second chance to get it wrong.
   */
  const readSaved = useCallback(
    async (
      path: string,
    ): Promise<
      | { ok: true; content: string; sha: string }
      | { ok: false; message: string; expired: boolean }
    > => {
      if (!repo) {
        const file = readLocalFile(path)
        if (!file) {
          return { ok: false, message: `${path} is not saved in this browser.`, expired: false }
        }
        return { ok: true, content: file.content, sha: LOCAL_SAVED }
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
    async (path: string) => {
      if (!hasWorkspace) return
      // A never-committed file has nothing on GitHub under its path, so reading it
      // would 404. Its draft *is* the file: reopen it exactly as it was created —
      // no sha, empty baseline, so it still reads as unsaved.
      if (pendingPaths.has(path)) {
        const draft = loadDraft(docIdForPath(path))
        setBaseline('')
        setLoadedSha(null)
        setOpenPath(path)
        setText(draft?.content ?? templateFor(fileKind(path)))
        return
      }
      const res = await readSaved(path)
      if (!res.ok) {
        if (!res.expired) toast.error(res.message)
        return
      }
      const draft = loadDraft(docIdForPath(path))
      setBaseline(res.content)
      setLoadedSha(res.sha)
      setOpenPath(path)
      // Only prefer the draft when it actually differs from what's saved.
      const draftDiffers =
        draft !== null && contentDiffers(draft.content, res.content, fileKind(path))
      setText(draftDiffers && draft ? draft.content : res.content)
    },
    [hasWorkspace, pendingPaths, docIdForPath, readSaved],
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

  /* ---------------------------------------------------------------- */
  /* Agent Link                                                        */
  /* ---------------------------------------------------------------- */

  /** The editor's imperative handle, so an agent's edit lands as one CodeMirror
   *  transaction rather than a whole-document swap — see `EditorHandle`. Null
   *  whenever no text editor is mounted (a canvas is open, or the diff view has
   *  taken the pane), which `applyEdits` below handles rather than refuses. */
  const editorRef = useRef<EditorHandle | null>(null)
  /** The markdown reading pane, for the scroll sync below. */
  const markdownPreviewRef = useRef<MarkdownPreviewHandle | null>(null)

  /**
   * Two-way scroll sync for markdown: double-click a line to find it in the
   * document, double-click a block to find it in the source.
   *
   * Driven through the two imperative handles rather than through state. A jump is
   * an event, and the same line double-clicked twice has to jump twice — which a
   * prop holding a line number can't express, and which the usual nonce workaround
   * only buys by re-rendering the whole document (every embedded diagram included)
   * on each jump.
   */
  const revealInPreview = useCallback((line: number) => {
    markdownPreviewRef.current?.revealLine(line)
  }, [])
  const revealInEditor = useCallback((line: number) => {
    editorRef.current?.revealLine(line)
  }, [])

  const bridgeState: BridgeState = useMemo(
    () => ({
      mode: githubEnabled ? 'github' : 'local',
      repo: repo
        ? {
            owner: repo.owner,
            name: repo.name,
            branch: repo.branch,
            defaultBranch: repo.defaultBranch,
          }
        : null,
      openPath,
      kind,
      dirty,
      lineCount: text === '' ? 0 : text.split('\n').length,
      charCount: text.length,
      // Reported so an agent stops hardcoding colors. The name is the dropdown's
      // own answer minus its UI sentinels: a preset id, `custom` for a hand-tuned
      // palette, null for no theme at all. `mode` is the same light/dark the canvas
      // runs in, which is the part that matters for a scene.
      theme: {
        name:
          currentTheme === NONE_THEME
            ? null
            : currentTheme === CUSTOM_THEME
              ? 'custom'
              : currentTheme,
        mode: canvasTheme,
      },
    }),
    [githubEnabled, repo, openPath, kind, dirty, text, currentTheme, canvasTheme],
  )

  /**
   * One of the agent's document commands, resolved onto an actual document.
   *
   * This is what protocol 4's `path` buys, and the shape it takes is dictated by
   * the fact that there are three places a document can be living, only one of
   * which is React state:
   *
   *   - **The open one.** Held in `text`, edited through the live editor, with
   *     `baseline` behind it. Reached by omitting the path — or by naming the file
   *     that happens to be open, which resolves to exactly the same target so the
   *     human's undo history does not depend on the agent's spelling.
   *   - **A never-saved file.** Its localStorage draft is the only copy there is;
   *     the saved store has nothing under the path.
   *   - **A saved file.** Read through `readSaved`, with a draft layered over it
   *     when one exists, because the draft is the working copy the human would see
   *     if they opened it — and answering with saved bytes instead is how an agent
   *     talks itself into re-doing an edit it made one call earlier.
   *
   * Which store "saved" means is `readSaved`'s problem, not this function's.
   */
  interface DocTarget {
    /** Null only for the untitled document, which has no path until it is saved
     *  somewhere. */
    path: string | null
    kind: FileKind
    /** The working copy: unsaved edits included. */
    text: string
    /** The saved content, or null when the path was never saved (and so cannot be
     *  compared against anything). */
    committed: string | null
    /** It is the document on screen, so writes go through the editor. */
    open: boolean
    /** This command brought the file into existence. */
    created: boolean
  }

  /**
   * Find the document a command names, fetching it if nobody has opened it.
   *
   * `create` is the difference between the mutating tools and the reading ones: a
   * path that names nothing is a file to be made for `ideate_edit`, and a mistake
   * worth reporting for `ideate_read`.
   */
  const resolveTarget = async (
    path: string | undefined,
    create: boolean,
  ): Promise<DocTarget> => {
    if (path === undefined || path === openPath) {
      return {
        path: openPath,
        kind,
        text,
        // `baseline` is only the *committed* content once there is a commit behind
        // it. For a never-committed file it is the empty string, and for the
        // scratch document it is a template nobody committed.
        committed: loadedSha === null ? null : baseline,
        open: true,
        created: false,
      }
    }
    if (!hasWorkspace) {
      throw new Error(
        'This tab has no file workspace: the human is signed in and has picked no ' +
          'repository, so there is nothing a path can name — only one untitled ' +
          'document, reached by omitting the path. Ask them to connect a repository ' +
          'if you need files.',
      )
    }
    const invalid = validatePath(path)
    if (invalid) throw new Error(`${path}: ${invalid}`)
    // Deciding "this file does not exist, I will create it" against a list that has
    // not arrived yet would create files that already exist, and then hand back a
    // template as their content.
    if (!savedPaths) {
      throw new Error('The file list has not loaded yet. Try again in a moment.')
    }
    const targetKind = fileKind(path)
    const draft = loadDraft(docIdForPath(path))
    if (savedPaths.has(path)) {
      const res = await readSaved(path)
      if (!res.ok) {
        throw new Error(
          res.expired ? 'The GitHub session expired. The user has been signed out.' : res.message,
        )
      }
      const committed = res.content
      const differs = draft !== null && contentDiffers(draft.content, committed, targetKind)
      return {
        path,
        kind: targetKind,
        text: differs && draft ? draft.content : committed,
        committed,
        open: false,
        created: false,
      }
    }
    // Not in the saved store. A draft under the path still means the file exists —
    // it was created here and never saved. Read straight from storage rather than
    // from `pendingPaths`, because a command that creates a file must be visible to
    // the very next command: `createdPaths` only reaches `pendingPaths` through a
    // render, and two agent calls can arrive between two of those.
    if (draft) {
      return {
        path,
        kind: targetKind,
        text: draft.content,
        committed: null,
        open: false,
        created: false,
      }
    }
    // A never-saved file with no draft: the human emptied it. The autosave gate
    // clears the slot the moment a document stops being dirty, and for a file with
    // nothing saved behind it the baseline is the empty string — so no draft, while
    // the path is still in `pendingPaths`, means the file exists and holds nothing.
    // The truth is worth more here than a template: an agent handed the starter
    // text would anchor its next edit on content the file does not have.
    if (pendingPaths.has(path)) {
      return { path, kind: targetKind, text: '', committed: null, open: false, created: false }
    }
    if (!create) {
      throw new Error(
        `No such file in ${workspaceLabel}: ${path}. ` +
          'Call ideate_list_files to see what is there.',
      )
    }
    return {
      path,
      kind: targetKind,
      text: templateFor(targetKind),
      committed: null,
      open: false,
      created: true,
    }
  }

  /**
   * Store what a command produced, and make the sidebar say so.
   *
   * The open document goes through `setText` and the existing machinery takes it
   * from there. A background file has no machinery: nothing is watching it, so this
   * is where its draft is written and where its dirty marker is turned on — or off,
   * when an edit happens to restore the committed content, which has to clear the
   * draft too or the file stays flagged forever over a difference of nothing.
   */
  const writeBack = (target: DocTarget, next: string): void => {
    if (target.open) {
      setText(next)
      return
    }
    const path = target.path
    // Unreachable: a target that is not the open document was resolved from a path
    // against a workspace. Narrowing rather than asserting.
    if (path === null) return
    const isDirty = target.committed === null || contentDiffers(next, target.committed, target.kind)
    const id = docIdForPath(path)
    if (isDirty) saveDraft(id, next)
    else clearDraft(id)
    if (target.created) setCreatedPaths((prev) => withPath(prev, path))
    setDirtyPaths((prev) => (isDirty ? withPath(prev, path) : withoutPaths(prev, [path])))
  }

  /** How to name the saved store in a message to an agent. */
  const workspaceLabel = repo ? `${repo.owner}/${repo.name}@${repo.branch}` : 'this browser'

  /**
   * Refuse a mutation that did not say which document it meant.
   *
   * The reading tools default to the open document happily. The mutating ones must
   * not, because the open document is not a stable address: the human browses their
   * files while the agent works, so "the open document" is whichever one they
   * clicked last, and an edit that lands on the wrong file is not recoverable by
   * reading it again.
   *
   * The exception is the **untitled** document, which has no path to name — the
   * scratch surface before anything has been saved. Keying on that rather than on
   * "is this local mode" is what makes the rule hold in both: local mode has files
   * now, and a connected repo still has an untitled document. And when the human
   * opens a file mid-turn, an agent that meant the untitled one is refused here
   * rather than silently redirected onto theirs.
   */
  function requirePath(path: string | undefined, tool: string): void {
    if (path !== undefined || openPath === null) return
    throw new Error(
      `${tool} needs a path. ${openPath} is open, but the open document changes as ` +
        'the human browses — so an edit with no path can land on a file you never ' +
        'read. Name the file you mean: ideate_status reports the open path, ' +
        'ideate_list_files the rest.',
    )
  }

  // Rebuilt every render on purpose. The hook reads it through a ref, so a fresh
  // object costs nothing and every capability closes over current state — a
  // memoized version would have to list every dependency the closures touch, and
  // a missed one means the agent silently editing a stale document.
  const linkCaps: AgentLinkCapabilities = {
    state: () => bridgeState,

    listFiles: () => ({ paths: repoFilePaths }),

    read: async (path) => {
      const target = await resolveTarget(path, false)
      return {
        path: target.path,
        text: target.text,
        committed:
          target.path !== null &&
          target.committed !== null &&
          !contentDiffers(target.text, target.committed, target.kind),
      }
    },

    applyEdits: async (edits, path) => {
      requirePath(path, 'ideate_edit')
      const target = await resolveTarget(path, true)
      requireText(target.kind)
      if (target.open) {
        const handle = editorRef.current
        // No editor mounted (a canvas is open, or the diff view has taken the
        // pane). Resolve against the very same text with the very same function and
        // go through `setText`; the editor reconciles it when it comes back.
        // Refusing here instead would make the tools mysteriously unavailable
        // whenever the human happened to be reading a diff.
        const next = handle
          ? handle.applyEdits(edits)
          : applyResolved(target.text, resolveEdits(target.text, edits))
        if (!handle) setText(next)
        return { path: target.path, created: false, text: next }
      }
      // Resolved before anything is written, so an edit whose anchor is missing
      // leaves a file it was about to create uncreated. Half a file, named after a
      // template the agent never asked for, is worse than no file.
      const next = applyResolved(target.text, resolveEdits(target.text, edits))
      writeBack(target, next)
      return { path: target.path, created: target.created, text: next }
    },

    writeText: async (text: string, path) => {
      requirePath(path, 'ideate_write')
      const target = await resolveTarget(path, true)
      requireText(target.kind)
      writeBack(target, text)
      return { path: target.path, created: target.created }
    },

    openFile: async (path) => {
      if (!hasWorkspace) throw new Error('No repository is connected — nothing to open.')
      // Checked against the file list first so a mistyped path says so, rather than
      // surfacing as a toast in the UI and an empty success to the agent.
      if (!repoFilePaths.includes(path)) {
        throw new Error(
          `No such file in ${workspaceLabel}: ${path}. ` +
            'Call ideate_list_files to see what is there.',
        )
      }
      // Opening from a tool is a fresh start, not a link follow — same reasoning
      // as `openFromTree`, where a Back button pointing at an unrelated file is
      // worse than no Back button.
      setLinkTrail([])
      await openFile(path)
    },

    createFile: (path, content) => {
      if (!hasWorkspace) {
        throw new Error('No repository is connected — nothing to create a file in.')
      }
      const invalid = validatePath(path)
      if (invalid) throw new Error(invalid)
      if (repoFilePaths.includes(path)) {
        // `edit`/`write`, not `open`: the path is all either of them needs, and
        // sending the agent through `open` would drag the human's editor to this file
        // as a side effect of a collision they never asked about. Same shape as
        // `createCanvas`'s refusal below, which points at `scene_edit` for the same
        // reason.
        throw new Error(
          `${path} already exists. Use ideate_edit (or ideate_write) with that path to ` +
            'change it — neither needs the file open.',
        )
      }
      // Exactly what the create prompt does on submit: the file becomes the open
      // document with nothing saved behind it. Nothing is pushed to GitHub —
      // committing stays a human action, which is what keeps an agent from writing
      // to the user's repository.
      const body = content ?? templateFor(fileKind(path))
      setLinkTrail([])
      setCreatedPaths((prev) => withPath(prev, path))
      // Written here rather than left to the autosave effect: for a file with
      // nothing saved behind it the draft is the only copy, and an agent creating
      // two files in quick succession must not depend on a render landing in
      // between.
      saveDraft(docIdForPath(path), body)
      setOpenPath(path)
      setLoadedSha(null)
      setBaseline('')
      setText(body)
    },

    // `createFile` for a canvas, with the drawing in the same call.
    //
    // Separate from `sceneEdit`'s create-if-missing path because of the last two
    // lines: this one *opens* what it made. `sceneEdit` exists to work on files the
    // human is not looking at and must not yank their editor around, but a canvas
    // that did not exist a moment ago has nothing to yank them away from, and a
    // drawing nobody is shown may as well not have been drawn.
    createCanvas: async (path, ops) => {
      if (!hasWorkspace) {
        throw new Error('No repository is connected — nothing to create a canvas in.')
      }
      const invalid = validatePath(path)
      if (invalid) throw new Error(invalid)
      // The extension is the whole of `fileKind`, so this is the same check the
      // service makes — kept here as well because the tab is the side that would
      // otherwise open a markdown document in response to a request to draw.
      if (fileKind(path) !== 'excalidraw') {
        throw new Error(
          `${path} is not a canvas: the extension decides the editor, and a canvas ends ` +
            'in .excalidraw. Use ideate_create_file for a diagram or a document.',
        )
      }
      if (repoFilePaths.includes(path)) {
        throw new Error(`${path} already exists. Use ideate_scene_edit to draw on it.`)
      }
      // Drawn once before anything is written, so a bad op leaves no half-made file
      // behind — the same all-or-nothing rule `applyEdits` follows.
      // Drawn before anything is written, so a bad op leaves no half-made file behind
      // — the same all-or-nothing rule `applyEdits` follows. This measures labels
      // correctly with no canvas on screen, because `lib/excalidrawFonts.ts` registered
      // Excalidraw's faces at page load rather than leaving it to a mounted editor.
      const drawn = ops.length
        ? await applySceneOps(EMPTY_SCENE, ops)
        : { text: EMPTY_SCENE, elementCount: 0, warnings: [] }
      setLinkTrail([])
      setCreatedPaths((prev) => withPath(prev, path))
      // Written straight away rather than left to the autosave effect: nothing is
      // saved behind this file, so its draft is the only copy of the drawing.
      saveDraft(docIdForPath(path), drawn.text)
      setOpenPath(path)
      setLoadedSha(null)
      setBaseline('')
      setText(drawn.text)

      return {
        path,
        created: true,
        applied: ops.length,
        elementCount: drawn.elementCount,
        warnings: drawn.warnings,
      }
    },

    // Takes the text to check rather than always reading the document: after an
    // edit the caller holds the new text and React has not re-rendered yet, so
    // reading state here would report on the document as it was before.
    check: async ({ text: override, path }) => {
      if (override !== undefined) {
        return {
          path: path ?? openPath,
          diagnostics: await collectDiagnostics(
            override,
            path === undefined ? kind : fileKind(path),
            appliedConfig,
          ),
        }
      }
      const target = await resolveTarget(path, false)
      return {
        path: target.path,
        diagnostics: await collectDiagnostics(target.text, target.kind, appliedConfig),
      }
    },

    sceneGet: async (full, path) => {
      const target = await resolveTarget(path, false)
      requireScene(target.kind)
      return { path: target.path, ...summarizeScene(target.text, full) }
    },

    sceneEdit: async (ops, path) => {
      requirePath(path, 'ideate_scene_edit')
      const target = await resolveTarget(path, true)
      requireScene(target.kind)
      const { text: next, elementCount, warnings } = await applySceneOps(target.text, ops)
      // Through `setText` (or a draft), not a canvas ref: `CanvasInner` already
      // ingests an external `value` via `updateScene`, so dirty tracking (rule 9)
      // and the file's own stored background (rule 10) keep working untouched.
      writeBack(target, next)
      return {
        path: target.path,
        created: target.created,
        applied: ops.length,
        elementCount,
        warnings,
      }
    },

    cursor: () => editorRef.current?.cursor() ?? null,
  }

  // The two surfaces hold incompatible content, so a tool aimed at the wrong one
  // is answered with the name of the tool that would have worked. Takes the
  // target's kind rather than reading the open document's: since protocol 4 the
  // document a tool acts on is often not the one on screen.
  function requireText(target: FileKind): void {
    if (target === 'excalidraw') {
      throw new Error(
        'That document is an Excalidraw scene. Use ideate_scene_get and ' +
          'ideate_scene_edit — the text tools cannot edit a canvas.',
      )
    }
  }
  function requireScene(target: FileKind): void {
    if (target !== 'excalidraw') {
      throw new Error(
        `That document is ${target}, not an Excalidraw scene. Use ideate_read and ` +
          'ideate_edit instead.',
      )
    }
  }

  /** Where the Agent Link service lives: the stored override, else the build's
   *  default. Unlike the on/off switch this *is* an `AppConfig` field, because it
   *  describes the deployment rather than this tab — see the comment block in
   *  lib/types.ts. */
  const mcpOrigin = normalizeMcpOrigin(config.mcpOrigin ?? DEFAULT_MCP_ORIGIN)

  const agentLink = useAgentLink({
    enabled: agentLinkOn,
    mcpOrigin,
    state: bridgeState,
    caps: linkCaps,
  })
  // "Connected" means an agent has *attached*, not merely that this tab is paired.
  // Treating a live socket as connected would light this up as soon as the switch
  // was flipped, whether or not anything had chosen to drive the document.
  const linkAttached = agentLinkOn && agentLink.status === 'attached'
  const linkWaiting = agentLinkOn && agentLink.status === 'paired'

  const newDiagram = useCallback(
    (dirPath?: string, newKind: FileKind = 'mermaid') => {
      // Signed in with no repo picked: there is nowhere to put a named file, so
      // this is the untitled scratch document and nothing else.
      if (!hasWorkspace) {
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
        onSubmit: (path) => {
          setPromptOpen(false)
          setCreatedPaths((prev) => withPath(prev, path))
          const body = templateFor(fileKind(path))
          // The draft is this file's only copy until it's saved — see the agent's
          // `createFile` for why it's written here and not by the effect.
          saveDraft(docIdForPath(path), body)
          setOpenPath(path)
          setLoadedSha(null)
          setBaseline('')
          setText(body)
        },
      })
    },
    [hasWorkspace, localMode, repo, docIdForPath, openPrompt],
  )

  const requestRename = useCallback(
    (node: TreeNode) => {
      if (!hasWorkspace || node.type !== 'file') return
      // A never-committed file exists only in this browser: it is spliced into the
      // sidebar from `pendingPaths` and its content is a localStorage draft, with
      // nothing on GitHub under either name. Renaming it through the API would ask
      // git to move a path that isn't in the tree, which answers 404 — so this one
      // is a local move of the draft slot, exactly like creating it under the new
      // name would have been.
      const local = pendingPaths.has(node.path)
      openPrompt({
        title: 'Rename file',
        description: localMode
          ? 'Move or rename this file. It is stored in this browser.'
          : local
            ? `Rename this file before its first commit. It only exists in this browser, so nothing on ${repo?.branch} changes until you commit.`
            : `Move or rename this file on ${repo?.branch}. Git history is preserved as a rename.`,
        label: 'New path',
        defaultValue: node.path,
        submitLabel: 'Rename',
        validate: validatePath,
        onSubmit: async (newPath) => {
          if (newPath === node.path) {
            setPromptOpen(false)
            return
          }
          // The saved case has to land on the store first: everything below moves
          // local bookkeeping to match, and doing that before the write would
          // leave the app pointing at a path the store never got.
          if (!local) {
            if (localMode) {
              if (!renameLocalFile(node.path, newPath)) {
                toast.error(`Could not rename ${node.path} — this browser's storage is full.`)
                return
              }
              refreshLocalFiles()
              if (openPath === node.path) setLoadedSha(LOCAL_SAVED)
            } else if (repo) {
              const res = await renameFile(
                repo.owner,
                repo.name,
                node.path,
                newPath,
                repo.branch,
              )
              if (!res.ok) {
                if (handleExpiredSession(res.error)) return
                toast.error(res.error.message)
                return
              }
              if (openPath === node.path) setLoadedSha(res.data.sha)
            }
          }
          setPromptOpen(false)
          // Carry any unsaved draft over to the new path. For a never-saved file
          // this *is* the rename — the draft is the only copy of the file.
          const oldId = docIdForPath(node.path)
          const newId = docIdForPath(newPath)
          const draft = loadDraft(oldId)
          if (draft) saveDraft(newId, draft.content)
          clearDraft(oldId)
          // A never-saved rename moves the only copy there is, so the pending set
          // has to follow it or the file drops out of the sidebar under both names.
          if (local) {
            setCreatedPaths((prev) => withPath(withoutPaths(prev, [node.path]), newPath))
          }
          setDirtyPaths((prev) => {
            if (!prev.has(node.path)) return prev
            const next = new Set(prev)
            next.delete(node.path)
            next.add(newPath)
            return next
          })
          if (openPath === node.path) setOpenPath(newPath)
          toast.success(`Renamed to ${newPath}`)
          // A never-saved rename changed nothing on the branch, and `pendingPaths`
          // already re-splices the new name into the sidebar.
          if (!local && repo) void refreshTree(repo)
        },
      })
    },
    [
      hasWorkspace,
      localMode,
      repo,
      openPrompt,
      openPath,
      pendingPaths,
      docIdForPath,
      refreshLocalFiles,
      refreshTree,
    ],
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
    if (!hasWorkspace || !deleteTarget) return
    const paths = collectFilePaths(deleteTarget)
    const affectsOpen = !!openPath && paths.includes(openPath)
    // A never-saved file (the pending new one) only exists as a draft — there is
    // nothing in the saved store to remove, so skip the write for it.
    const committed = paths.filter((p) => !pendingPaths.has(p))
    // Drop every draft under the deleted paths. Left behind, a draft *is* a
    // never-saved file as far as the recovery effect above is concerned, so a
    // deleted file would reappear as a new one on the next load.
    const forget = () => {
      for (const p of paths) clearDraft(docIdForPath(p))
      setCreatedPaths((prev) => withoutPaths(prev, paths))
      setDirtyPaths((prev) => withoutPaths(prev, paths))
    }
    if (committed.length === 0) {
      if (affectsOpen) detachEditor()
      forget()
      setDeleteOpen(false)
      setDeleteTarget(null)
      return
    }
    if (localMode) {
      for (const p of committed) deleteLocalFile(p)
      refreshLocalFiles()
      forget()
      setDeleteOpen(false)
      setDeleteTarget(null)
      if (affectsOpen) detachEditor()
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
    forget()
    setDeleteOpen(false)
    setDeleteTarget(null)
    if (affectsOpen) detachEditor()
    void refreshTree(repo)
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
  ])

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
        // The path is on the branch now — the next tree fetch will carry it, so it
        // must stop being spliced in as a never-committed file. Hand it to the
        // tree in the same batch, or the sidebar drops the file for the length of
        // that fetch (see `treeWithPath`).
        setCreatedPaths((prev) => withoutPaths(prev, [path]))
        setTree((prev) => (prev ? treeWithPath(prev, path) : prev))
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

  /**
   * Save to the local store — local mode's whole of `commitCurrent`.
   *
   * Same shape and the same bookkeeping, minus everything that only a repo has: no
   * sha, so no conflict, and nothing to refetch afterwards because this *is* the
   * store. What it keeps is the part that matters: the saved content becomes the
   * baseline, so the document reads as clean and the diff has something to diff
   * against.
   */
  const saveLocal = useCallback(
    (path: string, content: string) => {
      if (!writeLocalFile(path, content)) {
        toast.error(
          `Could not save ${path} — this browser's storage is full. ` +
            'Export what you need, or delete a file you are done with.',
        )
        return
      }
      setBaseline(content)
      setLoadedSha(LOCAL_SAVED)
      setOpenPath(path)
      setCreatedPaths((prev) => withoutPaths(prev, [path]))
      refreshLocalFiles()
      // The scratch slot is spent: this document has a name now. Clear the slot for
      // the kind it came from, not just the mermaid one.
      clearDraft(scratchDocId)
      toast.success(`Saved ${path}`)
    },
    [refreshLocalFiles, scratchDocId],
  )

  const onSave = useCallback(() => {
    if (!hasWorkspace || !dirty || saving) return
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
        onSubmit: (path) => {
          setPromptOpen(false)
          if (localMode) saveLocal(path, text)
          else void commitCurrent(path, undefined, text)
        },
      })
      return
    }
    if (localMode) saveLocal(openPath, text)
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
  ])

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

  // Keyboard shortcuts, wherever there are files to act on: ⌘/Ctrl+S saves;
  // ⌘/Ctrl+Alt+N starts a new diagram. New-diagram uses Alt because browsers
  // reserve plain ⌘/Ctrl+N (new window) and won't let a page cancel it. `e.code`
  // (physical key) is used so macOS Option+N (a dead key) still matches.
  // ⌘/Ctrl+B toggles the file-tree sidebar.
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

  const canSave = hasWorkspace && dirty && text.trim().length > 0 && !saving
  // A canvas has no text to diff, and a file with nothing saved behind it has
  // nothing to diff against.
  const canDiff = kind !== 'excalidraw' && loadedSha !== null
  const showSidebar = hasWorkspace && sidebarOpen
  const saveHint = isMac ? '⌘ S' : 'Ctrl + S'
  const newHint = isMac ? '⌥ ⌘ N' : 'Ctrl + Alt + N'
  const sidebarHint = isMac ? '⌘ B' : 'Ctrl + B'

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex flex-none items-center justify-between gap-4 border-b bg-card px-4 py-2">
        <div className="flex items-center gap-2">
          {hasWorkspace ? (
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
              <Button
                size="sm"
                onClick={onSave}
                disabled={!canSave}
                title={`${localMode ? 'Save' : 'Commit'} (${saveHint})`}
              >
                {localMode ? 'Save' : saving ? 'Committing…' : 'Commit'}
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
                {/* Nothing to refresh in local mode: the sidebar is not a cached
                    view of a remote list, it is the store. */}
                {repo ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => void refreshTree(repo)}
                    disabled={treeLoading}
                    title="Refresh files"
                  >
                    <RefreshCw className={cn(treeLoading && 'animate-spin')} />
                  </Button>
                ) : null}
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
              ) : !localMode && tree === null ? (
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
            {hasWorkspace && linkTrail.length > 0 ? (
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
            {hasWorkspace ? (
              <span>
                {openPath ??
                  (localMode ? 'untitled (unsaved)' : 'untitled (unsaved local draft)')}
              </span>
            ) : (
              <span>Connect a repository to browse and commit your diagrams.</span>
            )}
            {localMode ? (
              <span className="text-muted-foreground/70">
                · local mode, files stay in this browser
              </span>
            ) : null}
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
              {/* Agent Link lives here, not in the diagram-config modal: it has
                  nothing to do with diagrams, and it applies to all three document
                  kinds. Labelled rather than icon-only, and always rendered, because
                  this button is the only indication that an agent can be editing the
                  document — an unlabelled plug says nothing to someone who has never
                  turned it on.

                  Clicking opens the modal rather than toggling: switching it on hands
                  a process outside the browser the ability to rewrite the open
                  document, which should not be one click on a toolbar control. */}
              <Button
                size="sm"
                variant={linkAttached ? 'secondary' : 'ghost'}
                className={linkAttached ? 'h-7 gap-1.5 text-primary' : 'h-7 gap-1.5'}
                onClick={() => setLinkOpen(true)}
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
                {linkAttached
                  ? 'Agent Connected'
                  : agentLinkOn
                    ? 'Awaiting Agent'
                    : 'Connect Agent'}
              </Button>
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
                  ref={editorRef}
                  value={text}
                  onChange={setText}
                  dark={editorDark}
                  kind={kind}
                  wrap={config.wrapLines}
                  // Only a committed file has something to diverge *from*; a new
                  // file (or the local scratch document) would otherwise show
                  // every one of its lines as added.
                  baseline={loadedSha !== null ? baseline : null}
                  filePaths={repoFilePaths}
                  docPath={openPath}
                  minimap={config.minimap}
                  // Only markdown has a document to scroll to; a diagram preview
                  // is one figure with no notion of a source line.
                  onRevealPreview={kind === 'markdown' ? revealInPreview : undefined}
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
                    ref={markdownPreviewRef}
                    onRevealSource={revealInEditor}
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

      <AgentLinkModal
        open={linkOpen}
        onOpenChange={setLinkOpen}
        enabled={agentLinkOn}
        onEnabledChange={enableAgentLink}
        status={agentLink.status}
        detail={agentLink.detail}
        agent={agentLink.agent}
        code={agentLink.code}
        onRegenerate={agentLink.regenerate}
        onRetry={agentLink.retry}
        mcpOrigin={mcpOrigin}
        onMcpOriginChange={(origin) => updateConfig({ mcpOrigin: origin })}
        mode={mode}
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
