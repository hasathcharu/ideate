import { describe, expect, it } from 'vitest'
import { canConsumeScratchDraft, needsDraft } from './draftLifecycle'

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
