import { beforeEach, describe, expect, it, vi } from 'vitest'

const { api } = vi.hoisted(() => ({ api: {
  repos: { getContent: vi.fn() },
  git: { getRef: vi.fn(), getCommit: vi.fn(), createTree: vi.fn(), createCommit: vi.fn(), updateRef: vi.fn() },
} }))
vi.mock('@octokit/rest', () => ({ Octokit: class { constructor() { return api } } }))
vi.mock('@/lib/session.server', () => ({ getGitHubToken: async () => 'test-token' }))

import { commitFiles, renameFile } from './github'

const missing = { status: 404 }
const file = (sha: string, content = 'old') => ({ data: { type: 'file', sha, content: Buffer.from(content).toString('base64') } })

beforeEach(() => {
  vi.resetAllMocks()
  api.git.getRef.mockResolvedValue({ data: { object: { sha: 'head-1' } } })
  api.git.getCommit.mockResolvedValue({ data: { tree: { sha: 'tree-1' } } })
  api.git.createTree.mockResolvedValue({ data: { sha: 'tree-2', tree: [{ path: 'a.mmd', sha: 'blob-2' }] } })
  api.git.createCommit.mockResolvedValue({ data: { sha: 'commit-2' } })
  api.git.updateRef.mockResolvedValue({ data: {} })
})

describe('snapshot mutations', () => {
  it('validates Save All against the captured head', async () => {
    api.repos.getContent.mockResolvedValue(file('changed'))
    const result = await commitFiles('owner', 'repo', [{ path: 'a.mmd', content: 'new', sha: 'loaded' }], 'main', 'Save')
    expect(result).toMatchObject({ ok: false, error: { kind: 'conflict' } })
    expect(api.git.getRef).toHaveBeenCalledBefore(api.repos.getContent)
    expect(api.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: 'head-1' }))
    expect(api.git.createTree).not.toHaveBeenCalled()
  })

  it('reports a competing ref advance without force-pushing', async () => {
    api.repos.getContent.mockResolvedValue(file('loaded'))
    api.git.updateRef.mockRejectedValue({ status: 422 })
    const result = await commitFiles('owner', 'repo', [{ path: 'a.mmd', content: 'new', sha: 'loaded' }], 'main', 'Save')
    expect(result).toMatchObject({ ok: false, error: { kind: 'conflict' } })
    expect(api.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ force: false }))
  })

  it('rejects an occupied non-file destination before writing any file', async () => {
    api.repos.getContent.mockImplementation(async ({ path }: { path: string }) =>
      path === 'folder' ? { data: [{ type: 'file', path: 'folder/child.mmd' }] } : file('loaded'))
    const result = await commitFiles('owner', 'repo', [
      { path: 'a.mmd', content: 'new', sha: 'loaded' },
      { path: 'folder', content: 'new' },
    ], 'main', 'Save')
    expect(result).toMatchObject({ ok: false, error: { kind: 'conflict' } })
    expect(api.git.createTree).not.toHaveBeenCalled()
  })

  it('rejects a rename destination that exists at the captured head', async () => {
    api.repos.getContent.mockImplementation(async ({ path }: { path: string }) => file(path === 'old.mmd' ? 'old-blob' : 'dest-blob'))
    const result = await renameFile('owner', 'repo', 'old.mmd', 'dest.mmd', 'main')
    expect(result).toMatchObject({ ok: false, error: { kind: 'conflict' } })
    expect(api.git.getRef).toHaveBeenCalledBefore(api.repos.getContent)
    expect(api.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ path: 'dest.mmd', ref: 'head-1' }))
    expect(api.git.createTree).not.toHaveBeenCalled()
  })

  it('renames the original blob from one captured head', async () => {
    api.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'dest.mmd') throw missing
      return file('old-blob')
    })
    const result = await renameFile('owner', 'repo', 'old.mmd', 'dest.mmd', 'main')
    expect(result).toMatchObject({ ok: true, data: { sha: 'old-blob' } })
    expect(api.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ path: 'old.mmd', ref: 'head-1' }))
    expect(api.git.createTree).toHaveBeenCalledWith(expect.objectContaining({ base_tree: 'tree-1' }))
    expect(api.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ force: false }))
  })

  it('gives an explicit result for a repository without an initial commit', async () => {
    api.git.getRef.mockRejectedValue({ status: 404 })
    const result = await commitFiles('owner', 'repo', [{ path: 'a.mmd', content: 'new' }], 'main', 'Save')
    expect(result).toMatchObject({ ok: false, error: { kind: 'conflict', message: expect.stringContaining('initial commit') } })
    expect(api.repos.getContent).not.toHaveBeenCalled()
  })
})
