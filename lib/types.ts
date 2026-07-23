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
  /** Raw YAML text of the global mermaid config — the single source of truth for
   *  theme, layout, and per-diagram settings. Edited via the settings cogwheel;
   *  the layout dropdown writes the `layout` key into it. Empty = mermaid
   *  defaults. */
  mermaidConfig: string
}

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

/** Discriminated result type for server actions so the client can branch on
 *  errors (especially 409 conflicts) without try/catch around RPC. */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError }

export interface ActionError {
  kind: 'unauthenticated' | 'not_found' | 'conflict' | 'rate_limited' | 'unknown'
  message: string
  status?: number
}
