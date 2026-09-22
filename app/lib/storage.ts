import type { AppConfig, PngScale } from './types'
import type { FileKind } from './tree'
import { validateMcpOrigin } from './mcpOrigin'

/**
 * Small shared preferences live in localStorage. Document bodies live in IndexedDB.
 */

const CONFIG_KEY = 'km:config'

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
type WriteReason = 'unavailable' | 'quota' | 'collision' | 'invalid' | 'missing'
export type StorageWrite = { ok: true } | { ok: false; reason: WriteReason }

const DEFAULT_CONFIG: AppConfig = {
  repo: null,
  exportBackground: 'white',
  pngScale: { mode: 'multiplier', value: 2 },
  svgTheme: 'forced',
  exportFrame: false,
  splitRatio: 0.5,
  sidebarWidth: 256,
  wrapLines: false,
  minimap: true,
  preferredCommitAction: 'generated',
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
    if (merged.svgTheme !== 'forced' && merged.svgTheme !== 'dynamic') {
      merged.svgTheme = DEFAULT_CONFIG.svgTheme
    }
    if (typeof merged.exportFrame !== 'boolean') merged.exportFrame = DEFAULT_CONFIG.exportFrame
    if (merged.preferredCommitAction !== 'generated' && merged.preferredCommitAction !== 'custom') {
      merged.preferredCommitAction = DEFAULT_CONFIG.preferredCommitAction
    }
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

/** Whether a stored value is a usable {@link PngScale}. */
function isPngScale(value: unknown): value is PngScale {
  if (typeof value !== 'object' || value === null) return false
  const spec = value as { mode?: unknown; value?: unknown }
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

/** This tab's pairing credential, canonical (uppercase, no separator). It is read
 *  aloud for convenience, but still authorizes access to the paired working copy
 *  and therefore stays in per-tab sessionStorage and out of URLs and logs. */
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
/* IndexedDB document storage                                          */
/* ------------------------------------------------------------------ */

export interface LocalFile { path: string; content: string; updatedAt: number }
export type DraftBaseRevision =
  | { status: 'known'; revision: string }
  | { status: 'absent' }
  | { status: 'unknown' }

/** Version 2 records the saved revision the first dirty edit was based on. */
export interface Draft {
  version: 2
  content: string
  updatedAt: number
  baseRevision: DraftBaseRevision
}

/** Asynchronous boundary used by document lifecycle code. */
export interface DocumentStorage {
  open(): Promise<StorageWrite>
  listLocalFiles(): Promise<StorageRead<string[]>>
  readLocalFile(path: string): Promise<StorageRead<LocalFile>>
  writeLocalFile(path: string, content: string): Promise<StorageWrite>
  deleteLocalFile(path: string): Promise<StorageWrite>
  readDraft(id: string): Promise<StorageRead<Draft>>
  writeDraft(id: string, content: string, baseRevision?: DraftBaseRevision): Promise<StorageWrite>
  createDraft(id: string, content: string, baseRevision?: DraftBaseRevision): Promise<StorageWrite>
  clearDraft(id: string): Promise<StorageWrite>
  listDraftPaths(prefix: string): Promise<StorageRead<string[]>>
}

const DB_NAME = 'ideate-documents'
const DB_VERSION = 1
const FILES = 'local-files'
const DRAFTS = 'drafts'
let opening: Promise<IDBDatabase | null> | null = null
const writeTails = new Map<string, Promise<void>>()

/** An open/upgrade failure is an error, never evidence that the workspace is empty. */
export function openDocumentStorage(): Promise<StorageWrite> {
  if (typeof indexedDB === 'undefined') return Promise.resolve({ ok: false, reason: 'unavailable' })
  if (!opening) {
    opening = new Promise((resolve) => {
      let request: IDBOpenDBRequest
      let settled = false
      const finish = (database: IDBDatabase | null) => {
        if (settled) { database?.close(); return }
        settled = true
        resolve(database)
      }
      try { request = indexedDB.open(DB_NAME, DB_VERSION) }
      catch { finish(null); return }
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES)
        if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS)
      }
      request.onblocked = () => finish(null)
      request.onerror = () => finish(null)
      request.onsuccess = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(FILES) || !db.objectStoreNames.contains(DRAFTS)) {
          db.close(); finish(null); return
        }
        db.onversionchange = () => { db.close(); opening = null }
        finish(db)
      }
    })
  }
  return opening.then((db) => db ? { ok: true } : { ok: false, reason: 'unavailable' })
}

async function database(): Promise<IDBDatabase | null> {
  const ready = await openDocumentStorage()
  return ready.ok ? opening : null
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => reject(tx.error)
  })
}

function failure(error: unknown): StorageWrite {
  return { ok: false, reason: error instanceof Error && error.name === 'QuotaExceededError' ? 'quota' : 'unavailable' }
}

/** Writes for the same document enter in caller order; unrelated documents may proceed. */
function orderedWrite(keys: string | readonly string[], run: () => Promise<StorageWrite>): Promise<StorageWrite> {
  const orderedKeys = [...new Set(typeof keys === 'string' ? [keys] : keys)].sort()
  const predecessors = orderedKeys.map((key) => writeTails.get(key) ?? Promise.resolve())
  let release!: () => void
  const done = new Promise<void>((resolve) => { release = resolve })
  const reservations = orderedKeys.map((key, index) => {
    const reserved = predecessors[index]!.then(() => done)
    writeTails.set(key, reserved)
    return reserved
  })
  return (async () => {
    await Promise.all(predecessors)
    try { return await run() }
    finally {
      release()
      orderedKeys.forEach((key, index) => {
        if (writeTails.get(key) === reservations[index]) writeTails.delete(key)
      })
    }
  })()
}

async function read<T>(store: string, key: string, valid: (value: unknown) => value is T): Promise<StorageRead<T>> {
  const db = await database()
  if (!db) return { status: 'unavailable' }
  try {
    const tx = db.transaction(store, 'readonly')
    const done = transactionDone(tx)
    const value: unknown = await requestValue(tx.objectStore(store).get(key))
    await done
    if (value === undefined) return { status: 'missing' }
    return valid(value) ? { status: 'ok', value } : { status: 'invalid' }
  } catch { return { status: 'unavailable' } }
}

async function keys(store: string, prefix = ''): Promise<StorageRead<string[]>> {
  const db = await database()
  if (!db) return { status: 'unavailable' }
  try {
    const tx = db.transaction(store, 'readonly')
    const done = transactionDone(tx)
    const values = await requestValue(tx.objectStore(store).getAllKeys())
    await done
    return { status: 'ok', value: values.filter((key): key is string => typeof key === 'string' && key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)).filter(Boolean).sort() }
  } catch { return { status: 'unavailable' } }
}

async function mutate(store: string, operation: (objects: IDBObjectStore) => void): Promise<StorageWrite> {
  const db = await database()
  if (!db) return { ok: false, reason: 'unavailable' }
  try {
    const tx = db.transaction(store, 'readwrite')
    const done = transactionDone(tx)
    operation(tx.objectStore(store))
    await done
    return { ok: true }
  } catch (error) { return failure(error) }
}

function validFile(value: unknown): value is LocalFile {
  const file = value as Partial<LocalFile> | null
  return !!file && typeof file.path === 'string' && typeof file.content === 'string' &&
    typeof file.updatedAt === 'number' && Number.isFinite(file.updatedAt)
}
function parseDraft(value: unknown): Draft | null {
  const draft = value as Record<string, unknown> | null
  if (!draft || typeof draft.content !== 'string') return null
  // This schema has not shipped, so there is no migration path for the
  // unversioned development format. Do not mistake it for a current draft.
  if (draft.version === undefined) return null
  const base = draft.baseRevision as Partial<DraftBaseRevision> | null
  const validBase = !!base && (base.status === 'absent' || base.status === 'unknown' ||
    (base.status === 'known' && typeof base.revision === 'string' && base.revision.length > 0))
  if (draft.version !== 2 || !validBase || typeof draft.updatedAt !== 'number' || !Number.isFinite(draft.updatedAt)) {
    return null
  }
  return {
    version: 2, content: draft.content, updatedAt: draft.updatedAt,
    baseRevision: base as DraftBaseRevision,
  }
}

export const listLocalFilesResult = (): Promise<StorageRead<string[]>> => keys(FILES)
export const readLocalFileResult = (path: string): Promise<StorageRead<LocalFile>> => read(FILES, path, validFile)
export async function readDraftResult(id: string): Promise<StorageRead<Draft>> {
  const db = await database()
  if (!db) return { status: 'unavailable' }
  try {
    const tx = db.transaction(DRAFTS, 'readonly')
    const done = transactionDone(tx)
    const value: unknown = await requestValue(tx.objectStore(DRAFTS).get(id))
    await done
    if (value === undefined) return { status: 'missing' }
    const parsed = parseDraft(value)
    return parsed ? { status: 'ok', value: parsed } : { status: 'invalid' }
  } catch { return { status: 'unavailable' } }
}
export const listDraftPathsResult = (owner: string, repo: string, branch: string): Promise<StorageRead<string[]>> =>
  keys(DRAFTS, docIdForFile(owner, repo, branch, ''))
export const listLocalDraftPathsResult = (): Promise<StorageRead<string[]>> => keys(DRAFTS, docIdForLocalFile(''))

export const writeLocalFileResult = (path: string, content: string): Promise<StorageWrite> =>
  orderedWrite(`file:${path}`, () => mutate(FILES, (store) => { store.put({ path, content, updatedAt: Date.now() }, path) }))
export const deleteLocalFile = (path: string): Promise<StorageWrite> =>
  orderedWrite(`file:${path}`, () => mutate(FILES, (store) => { store.delete(path) }))
export const writeDraftResult = (id: string, content: string,
  baseRevision: DraftBaseRevision = { status: 'unknown' }): Promise<StorageWrite> =>
  orderedWrite(`draft:${id}`, () => mutate(DRAFTS, (store) => {
    store.put({ version: 2, content, updatedAt: Date.now(), baseRevision }, id)
  }))
export const createDraftResult = (id: string, content: string,
  baseRevision: DraftBaseRevision = { status: 'absent' }): Promise<StorageWrite> =>
  orderedWrite(`draft:${id}`, async () => {
    const db = await database()
    if (!db) return { ok: false, reason: 'unavailable' }
    try {
      const tx = db.transaction(DRAFTS, 'readwrite')
      const done = transactionDone(tx)
      const drafts = tx.objectStore(DRAFTS)
      if (await requestValue(drafts.getKey(id)) !== undefined) {
        tx.abort(); await done.catch(() => undefined); return { ok: false, reason: 'collision' }
      }
      drafts.add({ version: 2, content, updatedAt: Date.now(), baseRevision }, id)
      await done
      return { ok: true }
    } catch (error) { return failure(error) }
  })
export const clearDraft = (id: string): Promise<StorageWrite> =>
  orderedWrite(`draft:${id}`, () => mutate(DRAFTS, (store) => { store.delete(id) }))

export interface DraftBatchChange {
  id: string
  content: string | null
  baseRevision?: DraftBaseRevision
}

/** Apply a multi-document working-copy change in one IndexedDB transaction. */
export function writeDraftBatchResult(changes: readonly DraftBatchChange[]): Promise<StorageWrite> {
  const ids = changes.map(({ id }) => id)
  if (new Set(ids).size !== ids.length) return Promise.resolve({ ok: false, reason: 'invalid' })
  return orderedWrite(ids.map((id) => `draft:${id}`), () => mutate(DRAFTS, (store) => {
    const updatedAt = Date.now()
    for (const change of changes) {
      if (change.content === null) store.delete(change.id)
      else store.put({
        version: 2,
        content: change.content,
        updatedAt,
        baseRevision: change.baseRevision ?? { status: 'unknown' },
      }, change.id)
    }
  }))
}

export const documentStorage: DocumentStorage = {
  open: openDocumentStorage,
  listLocalFiles: listLocalFilesResult,
  readLocalFile: readLocalFileResult,
  writeLocalFile: writeLocalFileResult,
  deleteLocalFile,
  readDraft: readDraftResult,
  writeDraft: writeDraftResult,
  createDraft: createDraftResult,
  clearDraft,
  listDraftPaths: (prefix) => keys(DRAFTS, prefix),
}

async function move(store: string, from: string, to: string): Promise<StorageWrite> {
  const namespace = store === FILES ? 'file' : 'draft'
  return orderedWrite([`${namespace}:${from}`, `${namespace}:${to}`], async () => {
    const db = await database()
    if (!db) return { ok: false, reason: 'unavailable' }
    try {
      const tx = db.transaction(store, 'readwrite')
      const done = transactionDone(tx)
      const objects = tx.objectStore(store)
      const source: unknown = await requestValue(objects.get(from))
      const destination: unknown = await requestValue(objects.get(to))
      const sourceValid = store === FILES ? validFile(source) : parseDraft(source) !== null
      const destinationValid = store === FILES ? validFile(destination) : parseDraft(destination) !== null
      const reason: WriteReason | null = source === undefined ? 'missing' :
        !sourceValid ? 'invalid' : destination !== undefined ? destinationValid ? 'collision' : 'invalid' : null
      if (reason) { tx.abort(); await done.catch(() => undefined); return { ok: false, reason } }
      objects.put(store === FILES ? { ...(source as LocalFile), path: to } : source, to)
      objects.delete(from)
      await done
      return { ok: true }
    } catch (error) { return failure(error) }
  })
}
export const moveLocalFile = (from: string, to: string): Promise<StorageWrite> => move(FILES, from, to)
export const moveDraft = (from: string, to: string): Promise<StorageWrite> => move(DRAFTS, from, to)

/** Atomic local rename or save: saved file and its draft change together. */
export async function saveLocalFileAndClearDraft(path: string, content: string, draftId: string,
  onlyIfMissing = false, collisionDraftId?: string): Promise<StorageWrite> {
  const locks = [`file:${path}`, `draft:${draftId}`]
  if (collisionDraftId) locks.push(`draft:${collisionDraftId}`)
  return orderedWrite(locks, async () => {
    const db = await database()
    if (!db) return { ok: false, reason: 'unavailable' }
    try {
      const tx = db.transaction([FILES, DRAFTS], 'readwrite')
      const done = transactionDone(tx)
      const files = tx.objectStore(FILES)
      const drafts = tx.objectStore(DRAFTS)
      if (onlyIfMissing && (await requestValue(files.getKey(path)) !== undefined ||
          (collisionDraftId && await requestValue(drafts.getKey(collisionDraftId)) !== undefined))) {
        tx.abort(); await done.catch(() => undefined); return { ok: false, reason: 'collision' }
      }
      files.put({ path, content, updatedAt: Date.now() }, path)
      drafts.delete(draftId)
      await done
      return { ok: true }
    } catch (error) { return failure(error) }
  })
}

export async function deleteLocalFilesAndDrafts(paths: readonly string[], ids: readonly string[]): Promise<StorageWrite> {
  return orderedWrite([...paths.map((path) => `file:${path}`), ...ids.map((id) => `draft:${id}`)], () => mutateBoth((files, drafts) => {
    for (const path of paths) files.delete(path)
    for (const id of ids) drafts.delete(id)
  }))
}

export async function moveLocalFileAndDraft(from: string, to: string, oldId: string, newId: string,
  saved: boolean): Promise<StorageWrite> {
  return orderedWrite([`file:${from}`, `file:${to}`, `draft:${oldId}`, `draft:${newId}`], () => mutateBoth(async (files, drafts, tx) => {
    const source = saved ? await requestValue(files.get(from)) : undefined
    const destination = await requestValue(files.get(to))
    const draft = await requestValue(drafts.get(oldId))
    const newDraft = await requestValue(drafts.get(newId))
    const reason = saved && source === undefined ? 'missing' : saved && !validFile(source) ? 'invalid' :
      destination !== undefined || newDraft !== undefined ? 'collision' :
      draft !== undefined && parseDraft(draft) === null ? 'invalid' : !saved && draft === undefined ? 'missing' : null
    if (reason) { tx.abort(); throw new StorageAbort(reason) }
    if (saved) { files.put({ ...(source as LocalFile), path: to }, to); files.delete(from) }
    if (draft !== undefined) { drafts.put(draft, newId); drafts.delete(oldId) }
  }))
}

class StorageAbort extends Error { constructor(readonly reason: WriteReason) { super(reason) } }
async function mutateBoth(operation: (files: IDBObjectStore, drafts: IDBObjectStore, tx: IDBTransaction) => void | Promise<void>): Promise<StorageWrite> {
  const db = await database()
  if (!db) return { ok: false, reason: 'unavailable' }
  let done: Promise<void> | null = null
  try {
    const tx = db.transaction([FILES, DRAFTS], 'readwrite')
    done = transactionDone(tx)
    await operation(tx.objectStore(FILES), tx.objectStore(DRAFTS), tx)
    await done
    return { ok: true }
  } catch (error) {
    await done?.catch(() => undefined)
    return error instanceof StorageAbort ? { ok: false, reason: error.reason } : failure(error)
  }
}
