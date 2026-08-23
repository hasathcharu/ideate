/** Identifies which document a localStorage draft belongs to. */
export type DocId = string

/** Safe, non-secret session fields passed to the client. Never a token. */
export interface SessionUser {
  name: string | null
  image: string | null
  login: string | null
}

/** A repository the user can use as their database. */
export interface Repo {
  owner: string
  name: string
  private: boolean
  defaultBranch: string
}

/** The repo + branch currently selected. Branch lives alongside owner/name (not
 *  a sibling AppConfig field) so switching either one is a single atomic reset. */
export interface RepoRef {
  owner: string
  name: string
  defaultBranch: string
  branch: string
}

/** A branch in the "switch branch" dropdown. */
export interface Branch {
  name: string
  protected: boolean
}

/** Background painted behind an exported diagram: a solid white/black fill, no
 *  fill at all (transparent), or the current theme's own `background` color. */
export type ExportBackground = 'white' | 'black' | 'none' | 'theme'

/** Persisted app configuration (localStorage only — never secrets). */
export interface AppConfig {
  repo: RepoRef | null
  /** Background painted behind exported diagrams. */
  exportBackground: ExportBackground
  /** Editor pane width as a fraction (0–1) of the editor/preview split. */
  splitRatio: number
  /** File-tree sidebar width in pixels. */
  sidebarWidth: number
  /** Soft-wrap long lines in the text editor. An editor preference, so it is
   *  remembered across sessions like the pane sizes are. */
  wrapLines: boolean
  /** Show the viewfinder (minimap) column beside the text editor. */
  minimap: boolean
  /** Which editor the unsaved scratch document uses (local mode, or before a
   *  file is opened). Persisted so a reload reopens the same surface. Mirrors
   *  `FileKind` (lib/tree.ts), spelled out here so the storage layer doesn't
   *  depend on the tree module. */
  scratchKind: 'mermaid' | 'markdown' | 'excalidraw'
  /** Origin of the Agent Link service this deployment's tabs dial, overriding
   *  `DEFAULT_MCP_ORIGIN` (lib/config.ts). Null means "use the default"; set
   *  from the modal's Advanced options, chiefly to point at a service you run
   *  yourself when the shared one is at capacity. Validated on the way in by
   *  `validateMcpOrigin` (lib/mcpOrigin.ts) — https, or http on
   *  localhost:7391. */
  mcpOrigin: string | null
  /** Raw YAML text of the global mermaid config — the single source of truth for
   *  theme, layout, and per-diagram settings. Edited via the settings cogwheel;
   *  the layout dropdown writes the `layout` key into it. Empty = mermaid
   *  defaults. */
  mermaidConfig: string
}

/** Two pieces of Agent Link state are deliberately **not** in `AppConfig`, and the
 *  reason is the same fact that puts `mcpOrigin` firmly *in* it: config is shared
 *  by every tab on the origin.
 *
 *  - **The on/off switch** is per-tab (`sessionStorage`, via `loadAgentLink` /
 *    `saveAgentLink` in lib/storage.ts). Persisting it here meant one switch armed
 *    every tab opened afterwards, all of them raced for the bridge, and whichever
 *    won became the tab an agent drove. That left the human no way to say *which*
 *    tab to expose — which is the entire purpose of the switch.
 *  - **The pairing code** is per-tab for the same reason and one more: it is the
 *    credential that names this tab, so sharing it across the origin would make
 *    every tab answer to the same code and reintroduce exactly that race. It lives
 *    in `sessionStorage` too (`loadPairingCode` / `savePairingCode`), which is also
 *    what lets a reload rejoin the same session instead of orphaning the agent.
 *
 *  `mcpOrigin` is the opposite case and belongs here: *where the service is* is a
 *  property of the deployment, not of one tab, and a user who has switched to their
 *  own service means it for every tab they open. It is a URL, not a credential. */

/** A node in the repository file tree. */
export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

/** Result of reading a file from GitHub. */
export interface FileContent {
  path: string
  content: string
  /** The blob sha of the file as loaded — used for conflict detection on commit. */
  sha: string
}

/** A single commit touching a file, newest first. */
export interface FileCommit {
  sha: string
  message: string
  author: string
  date: string
  /** The file's path at this commit — differs from the current path across
   *  renames, so version previews read the correct historical path. */
  path: string
}

/** One page of commit history for a single path segment (see `listFileCommits`). */
export interface FileCommitsPage {
  commits: FileCommit[]
  /** True if this path has more commits beyond this page — fetch `page + 1`. */
  hasMore: boolean
  /** Set only once the last page of this segment is reached: the path this file
   *  was renamed from, if its earliest commit here is a rename, else null. */
  renamedFrom: string | null
}

/** Discriminated result type for server actions so the client can branch on
 *  errors (especially 409 conflicts) without try/catch around RPC. */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError }

export interface ActionError {
  kind:
    | 'unauthenticated'
    /** The connected repo itself is unreachable — see `repo_unavailable` below. */
    | 'repo_unavailable'
    | 'not_found'
    | 'conflict'
    | 'rate_limited'
    | 'unknown'
  message: string
  status?: number
}
