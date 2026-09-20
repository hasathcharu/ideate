import type { AppConfig, PngScale } from './types'
import type { FileKind } from './tree'
import { validateMcpOrigin } from './mcpOrigin'

/**
 * localStorage holds the WORKING COPY — uncommitted drafts and app config — and, in local mode
 * only, the saved files themselves.
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

/**
 * Stable id for a local file's draft. Cannot collide with `docIdForFile`, whose ids always contain
 * a `/` and an `@` before the colon — and cannot collide with the scratch slots either, which have
 * no third segment.
 */
export function docIdForLocalFile(path: string): string {
  return `local:file:${path}`
}

function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage
  } catch {
    return false
  }
}

export type StorageRead<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' | 'invalid' | 'unavailable' }
export type StorageWrite = { ok: true } | { ok: false; reason: 'unavailable' | 'quota' | 'collision' | 'invalid' | 'missing' }

function storageFailure(error: unknown): StorageWrite {
  return { ok: false, reason: error instanceof Error && error.name === 'QuotaExceededError' ? 'quota' : 'unavailable' }
}

const DEFAULT_CONFIG: AppConfig = {
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
}

export function loadConfig(): AppConfig {
  if (!hasStorage()) return { ...DEFAULT_CONFIG }
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    const merged = { ...DEFAULT_CONFIG, ...parsed }
    // A repo saved before branch support shipped is missing `branch`/ `defaultBranch` — that shape
    // can't drive the branch picker or the PR link, so treat it as disconnected rather than let
    // `undefined` leak into GitHub API calls and URLs.
    if (merged.repo && (!merged.repo.branch || !merged.repo.defaultBranch)) {
      merged.repo = null
    }
    // A config saved before the background chooser shipped stores a boolean
    // (paint white vs. transparent) — map it onto the new choice rather than
    // let a stale non-string value reach the export UI.
    if (typeof merged.exportBackground === 'boolean') {
      merged.exportBackground = merged.exportBackground ? 'white' : 'none'
    }
    // A PNG density stored by an older build (or hand-edited) could be any
    // shape at all, and an unusable one silently breaks every PNG export rather
    // than showing up as a bad value anywhere — so it is validated here, not
    // trusted at the canvas. Same defensive shape as the guards above.
    if (!isPngScale(merged.pngScale)) merged.pngScale = { ...DEFAULT_CONFIG.pngScale }
    // An MCP origin that no longer passes the TLS rule is dropped back to the default rather than
    // kept.
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

/** Whether a stored value is a usable {@link PngScale}. A finite, positive
 *  number is the whole of it for every mode but `auto`, which carries none. */
function isPngScale(value: unknown): value is PngScale {
  if (typeof value !== 'object' || value === null) return false
  const spec = value as { mode?: unknown; value?: unknown }
  if (spec.mode === 'auto') return true
  if (
    spec.mode !== 'multiplier' &&
    spec.mode !== 'dpi' &&
    spec.mode !== 'width' &&
    spec.mode !== 'height'
  ) {
    return false
  }
  return typeof spec.value === 'number' && Number.isFinite(spec.value) && spec.value > 0
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

/** Whether *this tab* offers itself to the Agent Link service, and under which pairing code. */
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
export function listLocalFilesResult(): StorageRead<string[]> {
  if (!hasStorage()) return { status: 'unavailable' }
  const paths: string[] = []
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (!key || !key.startsWith(LOCAL_FILE_PREFIX)) continue
      const path = key.slice(LOCAL_FILE_PREFIX.length)
      if (path) paths.push(path)
    }
  } catch {
    return { status: 'unavailable' }
  }
  return { status: 'ok', value: paths.sort() }
}

/** A saved local file, or an explicit absence/corruption/access result. */
export function readLocalFileResult(path: string): StorageRead<LocalFile> {
  if (!hasStorage()) return { status: 'unavailable' }
  let raw: string | null
  try {
    raw = window.localStorage.getItem(LOCAL_FILE_PREFIX + path)
  } catch {
    return { status: 'unavailable' }
  }
  if (raw === null) return { status: 'missing' }
  try {
    const parsed = JSON.parse(raw) as { content?: string; updatedAt?: number }
    if (typeof parsed?.content !== 'string' ||
      (parsed.updatedAt !== undefined && (typeof parsed.updatedAt !== 'number' || !Number.isFinite(parsed.updatedAt)))) {
      return { status: 'invalid' }
    }
    return { status: 'ok', value: { path, content: parsed.content, updatedAt: parsed.updatedAt ?? 0 } }
  } catch {
    return { status: 'invalid' }
  }
}

/** Save a local file. Returns false when the browser refused to store it. */
export function writeLocalFile(path: string, content: string): boolean {
  return writeLocalFileResult(path, content).ok
}

export function writeLocalFileResult(path: string, content: string): StorageWrite {
  if (!hasStorage()) return { ok: false, reason: 'unavailable' }
  try {
    window.localStorage.setItem(
      LOCAL_FILE_PREFIX + path,
      JSON.stringify({ content, updatedAt: Date.now() }),
    )
    return { ok: true }
  } catch (error) {
    return storageFailure(error)
  }
}

export function deleteLocalFile(path: string): StorageWrite {
  if (!hasStorage()) return { ok: false, reason: 'unavailable' }
  try {
    window.localStorage.removeItem(LOCAL_FILE_PREFIX + path)
    return { ok: true }
  } catch (error) {
    return storageFailure(error)
  }
}

/** Move a saved local file after checking that its destination is absent. */
export function moveLocalFile(from: string, to: string): StorageWrite {
  const source = readLocalFileResult(from)
  if (source.status !== 'ok') return { ok: false, reason: source.status }
  const destination = readLocalFileResult(to)
  if (destination.status !== 'missing') return { ok: false, reason: destination.status === 'ok' ? 'collision' : destination.status }
  const written = writeLocalFileResult(to, source.value.content)
  if (!written.ok) return written
  return deleteLocalFile(from)
}

export interface Draft {
  content: string
  updatedAt: number
}

export function readDraftResult(docId: string): StorageRead<Draft> {
  if (!hasStorage()) return { status: 'unavailable' }
  let raw: string | null
  try {
    raw = window.localStorage.getItem(DRAFT_PREFIX + docId)
  } catch {
    return { status: 'unavailable' }
  }
  if (raw === null) return { status: 'missing' }
  try {
    const parsed = JSON.parse(raw) as Draft
    if (typeof parsed?.content !== 'string' || typeof parsed?.updatedAt !== 'number' ||
      !Number.isFinite(parsed.updatedAt)) return { status: 'invalid' }
    return { status: 'ok', value: parsed }
  } catch {
    return { status: 'invalid' }
  }
}

export function writeDraftResult(docId: string, content: string): StorageWrite {
  if (!hasStorage()) return { ok: false, reason: 'unavailable' }
  try {
    const draft: Draft = { content, updatedAt: Date.now() }
    window.localStorage.setItem(DRAFT_PREFIX + docId, JSON.stringify(draft))
    return { ok: true }
  } catch (error) {
    return storageFailure(error)
  }
}

export function clearDraft(docId: string): StorageWrite {
  if (!hasStorage()) return { ok: false, reason: 'unavailable' }
  try {
    window.localStorage.removeItem(DRAFT_PREFIX + docId)
    return { ok: true }
  } catch (error) {
    return storageFailure(error)
  }
}

export function moveDraft(from: string, to: string): StorageWrite {
  const source = readDraftResult(from)
  if (source.status !== 'ok') return { ok: false, reason: source.status }
  const destination = readDraftResult(to)
  if (destination.status !== 'missing') return { ok: false, reason: destination.status === 'ok' ? 'collision' : destination.status }
  const written = writeDraftResult(to, source.value.content)
  if (!written.ok) return written
  return clearDraft(from)
}

/** Every path under `owner/repo@branch` that currently has a draft. */
export function listDraftPathsResult(owner: string, repo: string, branch: string): StorageRead<string[]> {
  return draftPathsUnderResult(DRAFT_PREFIX + docIdForFile(owner, repo, branch, ''))
}

/** The same, for local mode. */
export function listLocalDraftPathsResult(): StorageRead<string[]> {
  return draftPathsUnderResult(DRAFT_PREFIX + docIdForLocalFile(''))
}

function draftPathsUnderResult(prefix: string): StorageRead<string[]> {
  if (!hasStorage()) return { status: 'unavailable' }
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
    return { status: 'unavailable' }
  }
  return { status: 'ok', value: paths }
}
