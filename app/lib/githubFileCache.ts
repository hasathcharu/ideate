'use client'

import { readBinaryFile, readFile } from '@/app/actions/github'
import { docIdForFile, readCachedGitHubFile, writeCachedGitHubFile } from './storage'
import { isRasterImageFile } from './tree'
import type { ActionResult, FileContent, RepoRef } from './types'

type FileRepo = Pick<RepoRef, 'owner' | 'name' | 'branch'>
type DownloadResult = ActionResult<FileContent> & { cacheError?: string; cacheReadError?: string }

/** A hover download belongs to the file, not to the component or navigation that started it. */
const downloads = new Map<string, Promise<DownloadResult>>()
const cacheEpochs = new Map<string, number>()

/** Resolve a committed file from the unexpired browser copy before downloading it. */
export async function loadGitHubFile(repo: FileRepo, path: string): Promise<DownloadResult> {
  const id = docIdForFile(repo.owner, repo.name, repo.branch, path)
  const cached = await readCachedGitHubFile(id)
  if (cached.status === 'ok') {
    return { ok: true, data: { path, content: cached.value.content, sha: cached.value.sha } }
  }
  const downloaded = await downloadGitHubFile(repo, path)
  return cached.status === 'invalid' || cached.status === 'unavailable'
    ? { ...downloaded, cacheReadError: cached.status }
    : downloaded
}

export function downloadGitHubFile(repo: FileRepo, path: string): Promise<DownloadResult> {
  const id = docIdForFile(repo.owner, repo.name, repo.branch, path)
  const ongoing = downloads.get(id)
  if (ongoing) return ongoing
  const startedAtEpoch = cacheEpochs.get(id) ?? 0
  const download = (async (): Promise<DownloadResult> => {
    try {
      const result = isRasterImageFile(path)
        ? await readBinaryFile(repo.owner, repo.name, path, repo.branch)
        : await readFile(repo.owner, repo.name, path, repo.branch)
      if (result.ok && (cacheEpochs.get(id) ?? 0) === startedAtEpoch) {
        const stored = await writeCachedGitHubFile(id, result.data.content, result.data.sha)
        if (!stored.ok) return { ...result, cacheError: stored.reason }
      }
      return result
    } catch (error) {
      return { ok: false, error: { kind: 'unknown',
        message: error instanceof Error ? error.message : 'Could not download the file.' } }
    }
  })()
  downloads.set(id, download)
  void download.then(
    () => { if (downloads.get(id) === download) downloads.delete(id) },
    () => { if (downloads.get(id) === download) downloads.delete(id) },
  )
  return download
}

/** Refresh after the version check; a hover request may have started before that check. */
export async function downloadLatestGitHubFile(repo: FileRepo, path: string): Promise<DownloadResult> {
  const id = docIdForFile(repo.owner, repo.name, repo.branch, path)
  const prior = downloads.get(id)
  if (prior) {
    await prior
    if (downloads.get(id) === prior) downloads.delete(id)
  }
  return downloadGitHubFile(repo, path)
}

/** A successful commit wins over an older hover request still in flight. */
export function rememberCommittedGitHubFile(repo: FileRepo, path: string, content: string, sha: string) {
  const id = docIdForFile(repo.owner, repo.name, repo.branch, path)
  cacheEpochs.set(id, (cacheEpochs.get(id) ?? 0) + 1)
  return writeCachedGitHubFile(id, content, sha)
}

/** Warm a missing committed copy without repeating downloads for files already on disk. */
export async function prefetchGitHubFile(repo: FileRepo, path: string): Promise<DownloadResult | null> {
  const cached = await readCachedGitHubFile(docIdForFile(repo.owner, repo.name, repo.branch, path))
  return cached.status === 'ok' ? null : downloadGitHubFile(repo, path)
}
