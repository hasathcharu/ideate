import type { AppConfig } from './types'
import type { FileKind } from './tree'
import { validateMcpOrigin } from './mcpOrigin'

/**
 * localStorage holds the WORKING COPY — uncommitted drafts and app config — and,
 * in local mode only, the saved files themselves. Never tokens or secrets: those
 * live in the encrypted session, server-side.
 *
 * In GitHub mode the split is unchanged and is the whole architecture: GitHub is
 * the saved state, this is what has not been committed yet.
 *
 * Local mode has no GitHub, so something has to be the saved state, and until now
 * nothing was — there was one scratch document per kind and no way to keep two
 * diagrams at once. `km:file:` is that store. It is deliberately the *same*
 * relationship as a repo, not a second concept: a saved file plus a draft layered
 * over it, so dirty markers, the diff gutter, Restore and the agent's own
 * bookkeeping work in local mode through the code paths they already use.
 */

const CONFIG_KEY = 'km:config'
const DRAFT_PREFIX = 'km:draft:'
const LOCAL_FILE_PREFIX = 'km:file:'

/** Stable id for the local-only scratch document (before a repo is connected). */
export const SCRATCH_DOC_ID = 'local:scratch'

/** Scratch slot for an Excalidraw canvas. Deliberately separate from
 *  `SCRATCH_DOC_ID`: the kinds hold incompatible content, so giving each its
 *  own draft means toggling between them in local mode preserves all of them
 *  rather than overwriting one with the other. */
export const SCRATCH_SCENE_DOC_ID = 'local:scratch-scene'

/** Scratch slot for a markdown document — same reasoning as the scene slot. */
export const SCRATCH_MARKDOWN_DOC_ID = 'local:scratch-markdown'

/** The scratch draft slot for `kind`. Every caller that parks or restores the
 *  unsaved scratch document goes through this, so a new kind can never end up
 *  sharing another kind's slot. */
export function scratchDocIdFor(kind: FileKind): string {
  switch (kind) {
    case 'excalidraw':
      return SCRATCH_SCENE_DOC_ID
    case 'markdown':
      return SCRATCH_MARKDOWN_DOC_ID
    case 'mermaid':
      return SCRATCH_DOC_ID
  }
}

/** Stable id for a repo file's draft. Includes branch so the same path on two
 *  different branches never collides on the same draft. */
export function docIdForFile(owner: string, repo: string, branch: string, path: string): string {
  return `${owner}/${repo}@${branch}:${path}`
}

/** Stable id for a local file's draft.
 *
 *  Cannot collide with `docIdForFile`, whose ids always contain a `/` and an `@`
 *  before the colon — and cannot collide with the scratch slots either, which have
 *  no third segment. */
export function docIdForLocalFile(path: string): string {
  return `local:file:${path}`
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

const DEFAULT_CONFIG: AppConfig = {
  repo: null,
  exportBackground: 'white',
  splitRatio: 0.5,
  sidebarWidth: 256,
  wrapLines: false,
  minimap: true,
  scratchKind: 'mermaid',
  mcpOrigin: null,
  mermaidConfig: '',
}

export function loadConfig(): AppConfig {
  if (!hasStorage()) return { ...DEFAULT_CONFIG }
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    const merged = { ...DEFAULT_CONFIG, ...parsed }
    // A repo saved before branch support shipped is missing `branch`/
    // `defaultBranch` — that shape can't drive the branch picker or the PR
    // link, so treat it as disconnected rather than let `undefined` leak into
    // GitHub API calls and URLs. The user just reconnects the repo, which
    // repopulates both fields.
    if (merged.repo && (!merged.repo.branch || !merged.repo.defaultBranch)) {
      merged.repo = null
    }
    // A config saved before the background chooser shipped stores a boolean
    // (paint white vs. transparent) — map it onto the new choice rather than
    // let a stale non-string value reach the export UI.
    if (typeof merged.exportBackground === 'boolean') {
      merged.exportBackground = merged.exportBackground ? 'white' : 'none'
    }
    // An MCP origin that no longer passes the TLS rule is dropped back to the
    // default rather than kept. It is the same defensive shape as the two guards
    // above, and it matters more: an unusable origin here is not a cosmetic
    // fallback but a tab that cannot connect at all, with the reason buried in
    // localStorage where nobody would think to look.
    if (typeof merged.mcpOrigin === 'string' && validateMcpOrigin(merged.mcpOrigin)) {
      merged.mcpOrigin = null
    }
    // A build that stored `agentLink` in here left a stray key behind. Drop it, or
    // an old `true` would keep arming tabs that never asked — the exact behaviour
    // moving it to sessionStorage exists to stop.
    delete (merged as Record<string, unknown>).agentLink
    return merged
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: AppConfig): void {
  if (!hasStorage()) return
  try {
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
  } catch {
    /* quota / disabled storage — ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Agent Link — per tab, not per origin                                */
/* ------------------------------------------------------------------ */

/**
 * Whether *this tab* offers itself to the Agent Link service, and under which
 * pairing code.
 *
 * `sessionStorage`, not `localStorage`, and deliberately not part of `AppConfig`:
 * config is shared by every tab on the origin, so persisting either of these there
 * meant one switch armed every tab that opened afterwards. All of them would then
 * race for the service and whichever won became the tab an agent drove — leaving the
 * human no way to choose. Per-tab scoping makes "switch it on here" mean this tab,
 * and gives each tab a code of its own to be named by.
 *
 * Both survive a reload, which matters on each count: a refresh mid-session should
 * not silently drop the link, and it should come back under the *same* code, or the
 * agent is left holding one that no longer reaches anything.
 *
 * Where the service lives is the opposite kind of fact and lives in `AppConfig`
 * instead — see the comment block in lib/types.ts.
 */
const AGENT_LINK_KEY = 'km:agent-link'

function hasSessionStorage(): boolean {
  return typeof window !== 'undefined' && !!window.sessionStorage
}

export function loadAgentLink(): boolean {
  if (!hasSessionStorage()) return false
  try {
    return window.sessionStorage.getItem(AGENT_LINK_KEY) === 'on'
  } catch {
    return false
  }
}

export function saveAgentLink(enabled: boolean): void {
  if (!hasSessionStorage()) return
  try {
    if (enabled) window.sessionStorage.setItem(AGENT_LINK_KEY, 'on')
    else window.sessionStorage.removeItem(AGENT_LINK_KEY)
  } catch {
    /* quota / disabled storage — ignore */
  }
}

/** This tab's pairing code, canonical (uppercase, no separator). Never a token —
 *  it is a name the human reads aloud, and the service holds nothing durable that
 *  it unlocks. */
const PAIRING_CODE_KEY = 'km:agent-code'

export function loadPairingCode(): string | null {
  if (!hasSessionStorage()) return null
  try {
    return window.sessionStorage.getItem(PAIRING_CODE_KEY)
  } catch {
    return null
  }
}

export function savePairingCode(code: string | null): void {
  if (!hasSessionStorage()) return
  try {
    if (code) window.sessionStorage.setItem(PAIRING_CODE_KEY, code)
    else window.sessionStorage.removeItem(PAIRING_CODE_KEY)
  } catch {
    /* quota / disabled storage — ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Local-mode files — the saved state when there is no repository       */
/* ------------------------------------------------------------------ */

export interface LocalFile {
  path: string
  content: string
  updatedAt: number
}

/** Every saved local file's path. The store is the whole file system in local
 *  mode, so this is what the sidebar lists. */
export function listLocalFiles(): string[] {
  if (!hasStorage()) return []
  const paths: string[] = []
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (!key || !key.startsWith(LOCAL_FILE_PREFIX)) continue
      const path = key.slice(LOCAL_FILE_PREFIX.length)
      if (path) paths.push(path)
    }
  } catch {
    return []
  }
  return paths.sort()
}

/** A saved local file, or null when the path holds nothing. */
export function readLocalFile(path: string): LocalFile | null {
  if (!hasStorage()) return null
  try {
    const raw = window.localStorage.getItem(LOCAL_FILE_PREFIX + path)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { content?: string; updatedAt?: number }
    if (typeof parsed.content !== 'string') return null
    return { path, content: parsed.content, updatedAt: parsed.updatedAt ?? 0 }
  } catch {
    return null
  }
}

/**
 * Save a local file. Returns false when the browser refused to store it.
 *
 * The only function here that reports failure, and it has to: everything else in
 * this module is a cache of something that exists elsewhere, so swallowing a quota
 * error costs a redundant copy. A local file has no elsewhere. Losing this write
 * silently would tell the user their work is saved when it is gone, so the caller
 * says so instead.
 */
export function writeLocalFile(path: string, content: string): boolean {
  if (!hasStorage()) return false
  try {
    window.localStorage.setItem(
      LOCAL_FILE_PREFIX + path,
      JSON.stringify({ content, updatedAt: Date.now() }),
    )
    return true
  } catch {
    return false
  }
}

export function deleteLocalFile(path: string): void {
  if (!hasStorage()) return
  try {
    window.localStorage.removeItem(LOCAL_FILE_PREFIX + path)
  } catch {
    /* ignore */
  }
}

/** Move a saved local file. A no-op when `from` holds nothing, which is the
 *  never-saved case the caller handles by moving the draft alone. */
export function renameLocalFile(from: string, to: string): boolean {
  const existing = readLocalFile(from)
  if (!existing) return true
  if (!writeLocalFile(to, existing.content)) return false
  deleteLocalFile(from)
  return true
}

export interface Draft {
  content: string
  updatedAt: number
}

export function loadDraft(docId: string): Draft | null {
  if (!hasStorage()) return null
  try {
    const raw = window.localStorage.getItem(DRAFT_PREFIX + docId)
    return raw ? (JSON.parse(raw) as Draft) : null
  } catch {
    return null
  }
}

export function saveDraft(docId: string, content: string): void {
  if (!hasStorage()) return
  try {
    const draft: Draft = { content, updatedAt: Date.now() }
    window.localStorage.setItem(DRAFT_PREFIX + docId, JSON.stringify(draft))
  } catch {
    /* ignore */
  }
}

export function clearDraft(docId: string): void {
  if (!hasStorage()) return
  try {
    window.localStorage.removeItem(DRAFT_PREFIX + docId)
  } catch {
    /* ignore */
  }
}

/**
 * Every path under `owner/repo@branch` that currently has a draft.
 *
 * A never-committed file leaves no other record: its path isn't in the fetched
 * tree and GitHub has nothing under it, so the draft key *is* the file. Reading
 * the keys back is therefore what lets those files survive a reload — see
 * `pendingPaths` in `AppShell`, which treats a draft under a path the branch
 * doesn't have as exactly that.
 */
export function listDraftPaths(owner: string, repo: string, branch: string): string[] {
  return draftPathsUnder(DRAFT_PREFIX + docIdForFile(owner, repo, branch, ''))
}

/** The same, for local mode. */
export function listLocalDraftPaths(): string[] {
  return draftPathsUnder(DRAFT_PREFIX + docIdForLocalFile(''))
}

function draftPathsUnder(prefix: string): string[] {
  if (!hasStorage()) return []
  // The empty path yields the id's own prefix, and slicing by its length keeps
  // paths that contain a colon of their own intact.
  const paths: string[] = []
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (!key || !key.startsWith(prefix)) continue
      const path = key.slice(prefix.length)
      if (path) paths.push(path)
    }
  } catch {
    return []
  }
  return paths
}
