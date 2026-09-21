import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  currentTheme: '',
  calls: [] as string[],
  releases: [] as Array<() => void>,
  mermaid: {
    registerLayoutLoaders: vi.fn(),
    initialize: vi.fn((config: { theme?: string }) => { mock.currentTheme = config.theme ?? '' }),
    parse: vi.fn(async () => {
      mock.calls.push(mock.currentTheme)
      await new Promise<void>((resolve) => { mock.releases.push(resolve) })
    }),
    render: vi.fn(),
  },
}))

vi.mock('mermaid', () => ({ default: mock.mermaid }))
vi.mock('@mermaid-js/layout-elk', () => ({ default: [] }))

import { parseDiagram } from './mermaid'

beforeEach(() => {
  mock.currentTheme = ''
  mock.calls.length = 0
  mock.releases.length = 0
  vi.clearAllMocks()
})

describe('Mermaid lifecycle serialization', () => {
  it('keeps each concurrent parse under its own configuration', async () => {
    const light = parseDiagram('flowchart LR; A-->B', { theme: 'default' })
    const dark = parseDiagram('flowchart LR; B-->C', { theme: 'dark' })

    await vi.waitFor(() => expect(mock.calls).toEqual(['default']))
    expect(mock.mermaid.initialize).toHaveBeenCalledTimes(1)

    mock.releases.shift()?.()
    await vi.waitFor(() => expect(mock.calls).toEqual(['default', 'dark']))
    mock.releases.shift()?.()

    await expect(Promise.all([light, dark])).resolves.toEqual([{ ok: true }, { ok: true }])
  })
})
