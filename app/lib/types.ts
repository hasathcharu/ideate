/** Identifies which document a persisted draft belongs to. */
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

/**
 * How dense a PNG export is rasterized. Every mode resolves to a single pixel multiplier at export
 * time, once the drawing's natural size is known — which is the reason this is a *spec* rather than
 * a number.
 */
export type PngScale =
  | { mode: 'multiplier'; value: number }
  | { mode: 'dpi'; value: number }
  | { mode: 'width'; value: number }
  | { mode: 'height'; value: number }

/** SVGs can either keep the configured Mermaid palette or carry light and dark
 * variants that follow the viewer's `prefers-color-scheme`. */
export type SvgThemeMode = 'forced' | 'dynamic'

/** Action used by the primary half of the GitHub commit split button. */
export type PreferredCommitAction = 'generated' | 'custom'

/** Persisted app configuration (localStorage only — never secrets). */
export interface AppConfig {
  repo: RepoRef | null
  /** Background painted behind exported diagrams. */
  exportBackground: ExportBackground
  /** How dense a PNG export is rasterized — see {@link PngScale}. Remembered
   *  like the background choice beside it: someone exporting for print wants the
   *  next export at the same density, not back at the default. */
  pngScale: PngScale
  /** Whether SVG exports keep the configured palette or follow the viewer. */
  svgTheme: SvgThemeMode
  /** Add breathing room and rounded clipping to image exports. */
  exportFrame: boolean
  /** Editor pane width as a fraction (0–1) of the editor/preview split. */
  splitRatio: number
  /** File-tree sidebar width in pixels. */
  sidebarWidth: number
  /** Soft-wrap long lines in the text editor. An editor preference, so it is
   *  remembered across sessions like the pane sizes are. */
  wrapLines: boolean
  /** Show the viewfinder (minimap) column beside the text editor. */
  minimap: boolean
  /** Last commit action chosen from the split button. */
  preferredCommitAction: PreferredCommitAction
  /** Which editor the unsaved scratch document uses (local mode, or before a
   *  file is opened). Persisted so a reload reopens the same surface. Mirrors
   *  `FileKind` (lib/tree.ts), spelled out here so the storage layer doesn't
   *  depend on the tree module. */
  scratchKind: 'mermaid' | 'markdown' | 'excalidraw'
  /**
   * Origin of the Agent Link service this deployment's tabs dial, overriding `DEFAULT_MCP_ORIGIN`
   * (lib/config.ts).
   */
  mcpOrigin: string | null
  /** Raw YAML text of the global mermaid config — the single source of truth for
   *  theme, layout, and per-diagram settings. Edited via the settings cogwheel;
   *  the layout dropdown writes the `layout` key into it. Empty = mermaid
   *  defaults. */
  mermaidConfig: string
}

/**
 * Two pieces of Agent Link state are deliberately **not** in `AppConfig`, and the reason is the
 * same fact that puts `mcpOrigin` firmly *in* it: config is shared by every tab on the origin.
 */

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
