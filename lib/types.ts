import type { DiagramColors } from 'beautiful-mermaid'

/** A selectable theme in the UI. Built-in themes resolve synchronously; Shiki
 *  themes are loaded on demand and mapped through `fromShikiTheme()`. */
export interface ThemeOption {
  id: string
  label: string
  kind: 'builtin' | 'shiki'
  /** Whether the theme reads as dark — used only to pick a sensible editor look. */
  dark: boolean
}

export type { DiagramColors }

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

/** Persisted app configuration (localStorage only — never secrets). */
export interface AppConfig {
  repo: { owner: string; name: string } | null
  themeId: string
  bakeThemeOnExport: boolean
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
