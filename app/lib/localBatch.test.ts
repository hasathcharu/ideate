import { afterEach, describe, expect, it } from 'vitest'
import { FakeStorage } from '../test/fakes'
import { readLocalFileResult } from './storage'
import { saveLocalBatch } from './localBatch'

const originalWindow = globalThis.window
afterEach(() => Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow }))

describe('Local Save All settlement', () => {
  it('reports only durable paths when a background new file fails', () => {
    const storage = new FakeStorage()
    storage.failSetFor.add('km:file:failed.mmd')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } })
    const result = saveLocalBatch(['saved.mmd', 'failed.mmd'], path => path)
    expect(result).toEqual({
      saved: [{ path: 'saved.mmd', content: 'saved.mmd' }],
      failed: ['failed.mmd'],
    })
    expect(readLocalFileResult('saved.mmd').status).toBe('ok')
    expect(readLocalFileResult('failed.mmd')).toEqual({ status: 'missing' })
  })
})
