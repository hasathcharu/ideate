import { describe, expect, it } from 'vitest'
import { canConsumeScratchDraft, draftBaseFor, draftNeedsReconciliation, needsDraft } from './draftLifecycle'

describe('draft lifetime', () => {
  it('keeps an empty never-saved named file', () => {
    expect(needsDraft(false, true)).toBe(true)
    expect(needsDraft(false, false)).toBe(false)
  })

  it('consumes only the submitted scratch revision', () => {
    expect(canConsumeScratchDraft(true, 'submitted', 'submitted', 1, 1)).toBe(true)
    expect(canConsumeScratchDraft(true, 'submitted', 'newer', 1, 1)).toBe(false)
    expect(canConsumeScratchDraft(true, 'submitted', 'submitted', 1, 2)).toBe(false)
    expect(canConsumeScratchDraft(false, 'submitted', 'submitted', 1, 1)).toBe(false)
  })
})

describe('draft base revisions', () => {
  it('requires reconciliation for unknown and changed bases', () => {
    expect(draftNeedsReconciliation({ status: 'unknown' }, 'sha-2')).toBe(true)
    expect(draftNeedsReconciliation({ status: 'known', revision: 'sha-1' }, 'sha-2')).toBe(true)
    expect(draftNeedsReconciliation({ status: 'known', revision: 'sha-2' }, 'sha-2')).toBe(false)
  })

  it('distinguishes an absent saved file from a known revision', () => {
    expect(draftBaseFor(null)).toEqual({ status: 'absent' })
    expect(draftBaseFor('sha-1')).toEqual({ status: 'known', revision: 'sha-1' })
  })
})
