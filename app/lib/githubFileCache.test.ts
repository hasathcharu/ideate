import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readBinaryFile: vi.fn(),
  readCachedGitHubFile: vi.fn(),
  writeCachedGitHubFile: vi.fn(),
}))
vi.mock('@/app/actions/github', () => ({ readFile: mocks.readFile, readBinaryFile: mocks.readBinaryFile }))
vi.mock('./storage', () => ({
  docIdForFile: (owner: string, repo: string, branch: string, path: string) =>
    `${owner}/${repo}@${branch}:${path}`,
  readCachedGitHubFile: mocks.readCachedGitHubFile,
  writeCachedGitHubFile: mocks.writeCachedGitHubFile,
}))

import { downloadGitHubFile, downloadLatestGitHubFile, loadGitHubFile, prefetchGitHubFile, rememberCommittedGitHubFile } from './githubFileCache'

const repo = { owner: 'owner', name: 'repo', branch: 'main' }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.writeCachedGitHubFile.mockResolvedValue({ ok: true })
})

describe('GitHub hover downloads', () => {
  it('serves a cached background file without reaching GitHub', async () => {
    mocks.readCachedGitHubFile.mockResolvedValue({ status: 'ok', value: {
      content: 'cached body', sha: 'cached-sha', updatedAt: 1, expiresAt: 2,
    } })
    await expect(loadGitHubFile(repo, 'background.mmd')).resolves.toEqual({
      ok: true, data: { path: 'background.mmd', content: 'cached body', sha: 'cached-sha' },
    })
    expect(mocks.readCachedGitHubFile).toHaveBeenCalledWith('owner/repo@main:background.mmd')
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.readBinaryFile).not.toHaveBeenCalled()
  })

  it('downloads and caches a background file when its copy is absent', async () => {
    mocks.readCachedGitHubFile.mockResolvedValue({ status: 'missing' })
    mocks.readFile.mockResolvedValue({ ok: true, data: {
      path: 'uncached.mmd', content: 'downloaded', sha: 'downloaded-sha',
    } })
    await expect(loadGitHubFile(repo, 'uncached.mmd')).resolves.toMatchObject({
      ok: true, data: { content: 'downloaded', sha: 'downloaded-sha' },
    })
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
    expect(mocks.writeCachedGitHubFile).toHaveBeenCalledWith(
      'owner/repo@main:uncached.mmd', 'downloaded', 'downloaded-sha',
    )
  })

  it('shares an in-flight download and lets a newer commit win the cache', async () => {
    let finish!: (value: { ok: true; data: { path: string; content: string; sha: string } }) => void
    mocks.readFile.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const first = downloadGitHubFile(repo, 'diagram.mmd')
    const second = downloadGitHubFile(repo, 'diagram.mmd')
    expect(first).toBe(second)
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
    await rememberCommittedGitHubFile(repo, 'diagram.mmd', 'new', 'new-sha')
    finish({ ok: true, data: { path: 'diagram.mmd', content: 'old', sha: 'old-sha' } })
    await first
    expect(mocks.writeCachedGitHubFile).toHaveBeenCalledTimes(1)
    expect(mocks.writeCachedGitHubFile).toHaveBeenCalledWith('owner/repo@main:diagram.mmd', 'new', 'new-sha')
  })

  it('does not download an already cached file on hover', async () => {
    mocks.readCachedGitHubFile.mockResolvedValue({ status: 'ok', value: { content: 'saved', sha: 'sha' } })
    await expect(prefetchGitHubFile(repo, 'cached.mmd')).resolves.toBeNull()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it('fetches again when Refresh follows a hover download started earlier', async () => {
    let finishOld!: (value: { ok: true; data: { path: string; content: string; sha: string } }) => void
    mocks.readFile.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve }))
      .mockResolvedValueOnce({ ok: true, data: { path: 'later.mmd', content: 'new', sha: 'new-sha' } })
    const hover = downloadGitHubFile(repo, 'later.mmd')
    const refresh = downloadLatestGitHubFile(repo, 'later.mmd')
    finishOld({ ok: true, data: { path: 'later.mmd', content: 'old', sha: 'old-sha' } })
    await hover
    await expect(refresh).resolves.toMatchObject({ ok: true, data: { sha: 'new-sha' } })
    expect(mocks.readFile).toHaveBeenCalledTimes(2)
    expect(mocks.writeCachedGitHubFile).toHaveBeenLastCalledWith('owner/repo@main:later.mmd', 'new', 'new-sha')
  })
})
