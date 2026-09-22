import type { FileKind } from './tree'
import { scenesEqual } from './excalidraw'

function contentEqual(a: string, b: string, kind: FileKind): boolean {
  return kind === 'excalidraw' ? scenesEqual(a, b) : a === b
}

export type WorkspaceIdentity =
  | { mode: 'local' }
  | { mode: 'github'; owner: string; repo: string; branch: string }

export type DocumentIdentity =
  | { workspace: WorkspaceIdentity; path: string; kind: FileKind }
  | { workspace: WorkspaceIdentity; path: null; kind: FileKind }

export function workspaceKey(workspace: WorkspaceIdentity): string {
  return JSON.stringify(workspace)
}

export function documentKey(document: DocumentIdentity): string {
  return JSON.stringify([workspaceKey(document.workspace), document.path, document.kind])
}

export interface RequestTicket { sequence: number; context: string }

/** Latest request wins within a view; context prevents cross-workspace adoption. */
export class RequestGate {
  private sequence = 0
  begin(context: string): RequestTicket {
    return { sequence: ++this.sequence, context }
  }
  invalidate(): void { this.sequence += 1 }
  accepts(ticket: RequestTicket, currentContext: string): boolean {
    return ticket.sequence === this.sequence && ticket.context === currentContext
  }
}

export interface DocumentRecord {
  key: string
  identity: DocumentIdentity
  content: string
  revision: number
  savedContent: string
  savedRevision: string | null
  exists: boolean
  persistence: 'clean' | 'dirty' | 'failed'
}

const EMPTY_RECORDS: readonly DocumentRecord[] = []

/** Synchronous owner for browser working copies. Async callers settle by key and revision. */
export class WorkspaceStore {
  private records = new Map<string, DocumentRecord>()
  private mutationTails = new Map<string, Promise<void>>()
  private listeners = new Set<() => void>()
  private activeKey: string | null = null
  private generation = 0
  private recordsSnapshot: readonly DocumentRecord[] = EMPTY_RECORDS

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish() {
    this.recordsSnapshot = [...this.records.values()]
    for (const listener of this.listeners) listener()
  }

  snapshot = (): readonly DocumentRecord[] => this.recordsSnapshot

  get(key: string): DocumentRecord | undefined { return this.records.get(key) }
  /** Run dependent work for one document in arrival order. The queue survives failures. */
  async command<T>(identity: DocumentIdentity, run: () => Promise<T>): Promise<T> {
    const key = documentKey(identity)
    const previous = this.mutationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => tail)
    this.mutationTails.set(key, queued)
    await previous
    try { return await run() }
    finally {
      release()
      if (this.mutationTails.get(key) === queued) this.mutationTails.delete(key)
    }
  }

  /** Lock a set of documents in stable key order for folder operations. */
  commandMany<T>(identities: readonly DocumentIdentity[], run: () => Promise<T>): Promise<T> {
    const keys = [...new Set(identities.map(documentKey))].sort()
    const predecessors = keys.map((key) => this.mutationTails.get(key) ?? Promise.resolve())
    let release!: () => void
    const done = new Promise<void>((resolve) => { release = resolve })
    const reservations = keys.map((key, index) => {
      const reserved = predecessors[index]!.then(() => done)
      this.mutationTails.set(key, reserved)
      return reserved
    })
    return (async () => {
      await Promise.all(predecessors)
      try { return await run() }
      finally {
        release()
        keys.forEach((key, index) => {
          if (this.mutationTails.get(key) === reservations[index]) this.mutationTails.delete(key)
        })
      }
    })()
  }

  editIfRevision(identity: DocumentIdentity, expected: number, content: string): DocumentRecord {
    const actual = this.get(documentKey(identity))?.revision ?? 0
    if (actual !== expected) throw new Error(`Document changed during the command (revision ${expected} → ${actual}). Retry.`)
    return this.edit(identity, content)
  }
  /** Seed a resolved working copy without changing a record that another command already owns. */
  ensure(identity: DocumentIdentity, content: string, savedContent: string,
    savedRevision: string | null): DocumentRecord {
    const key = documentKey(identity)
    const current = this.records.get(key)
    if (current) return current
    const next: DocumentRecord = {
      key, identity, content, revision: 1, savedContent, savedRevision, exists: true,
      persistence: contentEqual(content, savedContent, identity.kind) && savedRevision !== null ? 'clean' : 'dirty',
    }
    this.records.set(key, next)
    this.publish()
    return next
  }
  list(): readonly DocumentRecord[] { return this.recordsSnapshot }
  active(): { key: string | null; generation: number } {
    return { key: this.activeKey, generation: this.generation }
  }

  activate(key: string): number {
    this.activeKey = key
    this.generation += 1
    this.publish()
    return this.generation
  }

  isActive(key: string, generation?: number): boolean {
    return this.activeKey === key && (generation === undefined || this.generation === generation)
  }

  /** Adopt a loaded file only if its request still owns the active selection. */
  adopt(identity: DocumentIdentity, content: string, savedContent: string,
    savedRevision: string | null, generation: number): boolean {
    const key = documentKey(identity)
    if (!this.isActive(key, generation)) return false
    const current = this.records.get(key)
    const next: DocumentRecord = {
      key, identity, content, revision: (current?.revision ?? 0) + 1,
      savedContent, savedRevision, exists: true,
      persistence: contentEqual(content, savedContent, identity.kind) && savedRevision !== null ? 'clean' : 'dirty',
    }
    this.records.set(key, next)
    this.publish()
    return true
  }

  edit(identity: DocumentIdentity, content: string): DocumentRecord {
    const key = documentKey(identity)
    const current = this.records.get(key)
    const next: DocumentRecord = {
      key, identity, content, revision: (current?.revision ?? 0) + 1,
      savedContent: current?.savedContent ?? '', savedRevision: current?.savedRevision ?? null,
      exists: true,
      persistence: contentEqual(content, current?.savedContent ?? '', identity.kind) && current?.savedRevision != null
        ? 'clean' : 'dirty',
    }
    this.records.set(key, next)
    this.publish()
    return next
  }

  /** A successful save advances the baseline without replacing newer working text. */
  settleSave(identity: DocumentIdentity, submittedContent: string,
    savedRevision: string, submittedRevision: number): DocumentRecord {
    const key = documentKey(identity)
    const current = this.records.get(key)
    const unchanged = !current ||
      (current.revision === submittedRevision &&
        contentEqual(current.content, submittedContent, identity.kind))
    const next: DocumentRecord = {
      key, identity, content: current?.content ?? submittedContent,
      revision: current?.revision ?? submittedRevision,
      savedContent: submittedContent, savedRevision, exists: true,
      persistence: unchanged ? 'clean' : 'dirty',
    }
    this.records.set(key, next)
    this.publish()
    return next
  }

  markPersistence(key: string, persistence: DocumentRecord['persistence']) {
    const current = this.records.get(key)
    if (!current) return
    this.records.set(key, { ...current, persistence })
    this.publish()
  }

  move(from: DocumentIdentity, to: DocumentIdentity, savedRevision?: string | null) {
    const current = this.records.get(documentKey(from))
    if (!current) return
    this.records.delete(current.key)
    const key = documentKey(to)
    this.records.set(key, {
      ...current, key, identity: to,
      savedRevision: savedRevision === undefined ? current.savedRevision : savedRevision,
    })
    this.publish()
  }

  forget(identity: DocumentIdentity) {
    if (this.records.delete(documentKey(identity))) this.publish()
  }
}
