import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { indexedDB, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb'

type StorageModule = typeof import('./storage')
let storage: StorageModule

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', indexedDB)
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('ideate-documents')
    request.onsuccess = request.onerror = request.onblocked = () => resolve()
  })
  storage = await import('./storage')
})
afterEach(() => vi.unstubAllGlobals())

describe('document storage boundary', () => {
  it('keeps full workspace identity in draft keys', () => {
    expect(storage.docIdForFile('owner', 'repo', 'main', 'docs/a.mmd')).toBe('owner/repo@main:docs/a.mmd')
    expect(storage.docIdForLocalFile('docs/a.mmd')).toBe('local:file:docs/a.mmd')
    expect(storage.scratchDocIdFor('markdown')).not.toBe(storage.scratchDocIdFor('mermaid'))
  })

  it('starts empty without reading legacy localStorage document records', async () => {
    const legacy = { length: 2, key: (i: number) => ['km:file:old.mmd', 'km:draft:local:file:old.mmd'][i],
      getItem: vi.fn(() => { throw new Error('legacy content must not be read') }) }
    vi.stubGlobal('window', { localStorage: legacy })
    await expect(storage.listLocalFilesResult()).resolves.toEqual({ status: 'ok', value: [] })
    expect(legacy.getItem).not.toHaveBeenCalled()
  })

  it('restores local files and drafts after the storage module reloads', async () => {
    await storage.writeLocalFileResult('a.mmd', 'saved')
    await storage.writeDraftResult('local:file:a.mmd', 'working')
    vi.resetModules()
    const reloaded = await import('./storage')
    await expect(reloaded.readLocalFileResult('a.mmd')).resolves.toMatchObject({
      status: 'ok', value: { content: 'saved' },
    })
    await expect(reloaded.readDraftResult('local:file:a.mmd')).resolves.toMatchObject({
      status: 'ok', value: { content: 'working' },
    })
  })

  it('persists local files and lists paths without loading their bodies', async () => {
    await expect(storage.writeLocalFileResult('b.mmd', 'B')).resolves.toEqual({ ok: true })
    await expect(storage.writeLocalFileResult('a.mmd', 'A')).resolves.toEqual({ ok: true })
    await expect(storage.listLocalFilesResult()).resolves.toEqual({ status: 'ok', value: ['a.mmd', 'b.mmd'] })
    await expect(storage.readLocalFileResult('a.mmd')).resolves.toMatchObject({
      status: 'ok', value: { path: 'a.mmd', content: 'A' },
    })
  })

  it('creates a draft only when its full document key is absent', async () => {
    await expect(storage.createDraftResult('local:file:a.mmd', 'first')).resolves.toEqual({ ok: true })
    await expect(storage.createDraftResult('local:file:a.mmd', 'replacement')).resolves.toEqual({
      ok: false, reason: 'collision',
    })
    await expect(storage.readDraftResult('local:file:a.mmd')).resolves.toMatchObject({
      status: 'ok', value: { content: 'first' },
    })
  })

  it('keeps the newest concurrent draft write', async () => {
    const first = storage.writeDraftResult('local:file:a.mmd', 'first')
    const second = storage.writeDraftResult('local:file:a.mmd', 'second')
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }])
    await expect(storage.readDraftResult('local:file:a.mmd')).resolves.toMatchObject({
      status: 'ok', value: { content: 'second' },
    })
  })

  it('moves a saved file and draft atomically and rejects collisions', async () => {
    await storage.writeLocalFileResult('a.mmd', 'saved')
    await storage.writeDraftResult('local:file:a.mmd', 'working')
    await storage.writeLocalFileResult('occupied.mmd', 'occupied')
    await expect(storage.moveLocalFileAndDraft('a.mmd', 'occupied.mmd',
      'local:file:a.mmd', 'local:file:occupied.mmd', true)).resolves.toEqual({ ok: false, reason: 'collision' })
    await expect(storage.readLocalFileResult('a.mmd')).resolves.toMatchObject({ status: 'ok' })
    await expect(storage.readDraftResult('local:file:a.mmd')).resolves.toMatchObject({ status: 'ok' })

    await expect(storage.moveLocalFileAndDraft('a.mmd', 'renamed.mmd',
      'local:file:a.mmd', 'local:file:renamed.mmd', true)).resolves.toEqual({ ok: true })
    await expect(storage.readLocalFileResult('a.mmd')).resolves.toEqual({ status: 'missing' })
    await expect(storage.readDraftResult('local:file:a.mmd')).resolves.toEqual({ status: 'missing' })
    await expect(storage.readLocalFileResult('renamed.mmd')).resolves.toMatchObject({
      status: 'ok', value: { content: 'saved' },
    })
    await expect(storage.readDraftResult('local:file:renamed.mmd')).resolves.toMatchObject({
      status: 'ok', value: { content: 'working' },
    })
  })

  it('reports quota failure and leaves the prior durable copy intact', async () => {
    await storage.writeDraftResult('local:file:a.mmd', 'original')
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    await expect(storage.writeDraftResult('local:file:a.mmd', 'replacement')).resolves.toEqual({
      ok: false, reason: 'quota',
    })
    put.mockRestore()
    await expect(storage.readDraftResult('local:file:a.mmd')).resolves.toMatchObject({
      status: 'ok', value: { content: 'original' },
    })
  })

  it('does not promote scratch over a concurrently created named draft', async () => {
    await storage.writeDraftResult('local:scratch', 'scratch')
    await storage.createDraftResult('local:file:a.mmd', 'other work')
    await expect(storage.saveLocalFileAndClearDraft('a.mmd', 'scratch', 'local:scratch', true,
      'local:file:a.mmd')).resolves.toEqual({ ok: false, reason: 'collision' })
    await expect(storage.readLocalFileResult('a.mmd')).resolves.toEqual({ status: 'missing' })
    await expect(storage.readDraftResult('local:scratch')).resolves.toMatchObject({ status: 'ok' })
  })

  it('saves a local file and clears its matching draft in one completed transaction', async () => {
    await storage.writeDraftResult('local:file:a.mmd', 'working')
    await expect(storage.saveLocalFileAndClearDraft('a.mmd', 'working', 'local:file:a.mmd')).resolves.toEqual({ ok: true })
    await expect(storage.readLocalFileResult('a.mmd')).resolves.toMatchObject({
      status: 'ok', value: { content: 'working' },
    })
    await expect(storage.readDraftResult('local:file:a.mmd')).resolves.toEqual({ status: 'missing' })
  })

  it('reports an unavailable database instead of an empty workspace', async () => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', undefined)
    const unavailable = await import('./storage')
    await expect(unavailable.openDocumentStorage()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(unavailable.listLocalFilesResult()).resolves.toEqual({ status: 'unavailable' })
    await expect(unavailable.readDraftResult('a')).resolves.toEqual({ status: 'unavailable' })
    await expect(unavailable.writeDraftResult('a', 'only copy')).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })
})
