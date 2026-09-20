import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeStorage } from '../test/fakes'
import {
  moveDraft, moveLocalFile, readDraftResult, readLocalFileResult,
  listLocalFilesResult, listLocalDraftPathsResult, writeDraftResult, writeLocalFileResult,
} from './storage'

let storage: FakeStorage
const originalWindow = globalThis.window

beforeEach(() => {
  storage = new FakeStorage()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } })
})
afterEach(() => Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow }))

describe('storage boundaries', () => {
  it('distinguishes absent, corrupt, and unavailable drafts', () => {
    expect(readDraftResult('a')).toEqual({ status: 'missing' })
    storage.setItem('km:draft:a', '{bad')
    expect(readDraftResult('a')).toEqual({ status: 'invalid' })
    storage.failGet = true
    expect(readDraftResult('a')).toEqual({ status: 'unavailable' })
  })

  it('does not treat a corrupt saved file as an absent destination', () => {
    storage.setItem('km:file:b.mmd', '{bad')
    writeLocalFileResult('a.mmd', 'source')
    expect(readLocalFileResult('b.mmd')).toEqual({ status: 'invalid' })
    expect(moveLocalFile('a.mmd', 'b.mmd')).toEqual({ ok: false, reason: 'invalid' })
    expect(readLocalFileResult('a.mmd')).toMatchObject({ status: 'ok', value: { content: 'source' } })
  })

  it('does not discard a draft when the destination write fails', () => {
    expect(writeDraftResult('a', 'only copy').ok).toBe(true)
    storage.failSet = true
    expect(moveDraft('a', 'b')).toEqual({ ok: false, reason: 'quota' })
    expect(readDraftResult('a')).toMatchObject({ status: 'ok', value: { content: 'only copy' } })
    expect(readDraftResult('b')).toEqual({ status: 'missing' })
  })

  it('does not discard a saved local file when its move cannot write', () => {
    writeLocalFileResult('a.mmd', 'only saved copy')
    storage.failSet = true
    expect(moveLocalFile('a.mmd', 'b.mmd')).toEqual({ ok: false, reason: 'quota' })
    expect(readLocalFileResult('a.mmd')).toMatchObject({ status: 'ok', value: { content: 'only saved copy' } })
    expect(readLocalFileResult('b.mmd')).toEqual({ status: 'missing' })
  })

  it('rejects local and draft destination collisions', () => {
    writeLocalFileResult('a.mmd', 'a')
    writeLocalFileResult('b.mmd', 'b')
    writeDraftResult('a', 'a')
    writeDraftResult('b', 'b')
    expect(moveLocalFile('a.mmd', 'b.mmd')).toEqual({ ok: false, reason: 'collision' })
    expect(moveDraft('a', 'b')).toEqual({ ok: false, reason: 'collision' })
    expect(readLocalFileResult('a.mmd')).toMatchObject({ status: 'ok', value: { content: 'a' } })
    expect(readLocalFileResult('b.mmd')).toMatchObject({ status: 'ok', value: { content: 'b' } })
  })

  it('leaves the source available if deletion fails after a successful copy', () => {
    writeDraftResult('a', 'only copy')
    storage.failRemove = true
    expect(moveDraft('a', 'b')).toEqual({ ok: false, reason: 'unavailable' })
    expect(readDraftResult('a')).toMatchObject({ status: 'ok', value: { content: 'only copy' } })
    expect(readDraftResult('b')).toMatchObject({ status: 'ok', value: { content: 'only copy' } })
  })

  it('treats an inaccessible storage property as unavailable', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { get localStorage() { throw new DOMException('blocked', 'SecurityError') } },
    })
    expect(writeLocalFileResult('a.mmd', 'a')).toEqual({ ok: false, reason: 'unavailable' })
    expect(readLocalFileResult('a.mmd')).toEqual({ status: 'unavailable' })
    expect(listLocalFilesResult()).toEqual({ status: 'unavailable' })
  })

  it('lists an empty never-saved file as a draft', () => {
    writeDraftResult('local:file:empty.mmd', '')
    expect(listLocalDraftPathsResult()).toEqual({ status: 'ok', value: ['empty.mmd'] })
  })
})
