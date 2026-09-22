import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveLocalBatch } from './localBatch'
import { saveLocalFileAndClearDraft } from './storage'

vi.mock('./storage', () => ({ saveLocalFileAndClearDraft: vi.fn() }))
const write = vi.mocked(saveLocalFileAndClearDraft)

beforeEach(() => write.mockReset())

describe('Local Save All settlement', () => {
  it('reports only durable paths when a background new file fails', async () => {
    write.mockImplementation(async (path) => path === 'failed.mmd'
      ? { ok: false, reason: 'quota' } : { ok: true })
    await expect(saveLocalBatch(['saved.mmd', 'failed.mmd'], async path => path,
      path => `local:file:${path}`)).resolves.toEqual({
      saved: [{ path: 'saved.mmd', content: 'saved.mmd' }],
      failed: ['failed.mmd'],
    })
  })
})
