'use server'

import { Octokit } from '@octokit/rest'
import { getGitHubToken } from '@/lib/session.server'
import { buildTree, isDiagramFile } from '@/lib/tree'
import type {
  ActionError,
  ActionResult,
  FileCommit,
  FileContent,
  Repo,
  TreeNode,
} from '@/lib/types'

/**
 * All GitHub I/O lives here, server-side only. The access token is read from the
 * encrypted session (never from the client) and used to construct Octokit for
 * the duration of a single request.
 *
 * HARD RULE: this app only ever reads and writes the `main` branch. There is no
 * branch selector and no branching — see the product brief.
 */
const MAIN_BRANCH = 'main'

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data }
}
function err(error: ActionError): ActionResult<never> {
  return { ok: false, error }
}

const UNAUTHENTICATED: ActionError = {
  kind: 'unauthenticated',
  message: 'You are not signed in to GitHub.',
  status: 401,
}

async function getOctokit(): Promise<Octokit | null> {
  const token = await getGitHubToken()
  if (!token) return null
  return new Octokit({ auth: token })
}

/** Map an Octokit/HTTP error into a structured, client-branchable error. */
function mapError(error: unknown): ActionError {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: number }).status
      : undefined
  const message =
    error instanceof Error ? error.message : 'Unexpected GitHub error.'

  switch (status) {
    case 401:
      return { kind: 'unauthenticated', message: 'GitHub authentication failed or expired.', status }
    case 403:
      return { kind: 'rate_limited', message: 'GitHub API access forbidden or rate-limited.', status }
    case 404:
      return { kind: 'not_found', message: 'Not found on GitHub (check the repo/path/branch).', status }
    case 409:
      return { kind: 'conflict', message: 'The file changed on GitHub since you loaded it.', status }
    case 422:
      return { kind: 'conflict', message: 'GitHub rejected the write (stale or missing sha).', status }
    default:
      return { kind: 'unknown', message, status }
  }
}

function encodeBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}
function decodeBase64(b64: string): string {
  return Buffer.from(b64.replace(/\n/g, ''), 'base64').toString('utf8')
}

/** Repo picker — repositories the signed-in user can push to. */
export async function listRepos(): Promise<ActionResult<Repo[]>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
      per_page: 100,
      sort: 'updated',
      affiliation: 'owner,collaborator,organization_member',
    })
    const mapped: Repo[] = repos.map((r) => ({
      owner: r.owner.login,
      name: r.name,
      private: r.private,
      defaultBranch: r.default_branch ?? MAIN_BRANCH,
    }))
    return ok(mapped)
  } catch (error) {
    return err(mapError(error))
  }
}

export interface TreeResult {
  tree: TreeNode[]
  /** GitHub caps recursive trees; if true, some files were omitted. */
  truncated: boolean
}

/** File browser — the repo's diagram files as a nested tree. */
export async function listTree(
  owner: string,
  repo: string,
): Promise<ActionResult<TreeResult>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    const { data } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: MAIN_BRANCH,
      recursive: 'true',
    })
    const filePaths = data.tree
      .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
      .map((entry) => entry.path as string)
      .filter(isDiagramFile)
    return ok({ tree: buildTree(filePaths), truncated: Boolean(data.truncated) })
  } catch (error) {
    // An empty repo (no commits / no `main` branch yet) 404s here. That isn't an
    // error for the browser — it just means there are no files yet, so surface it
    // as an empty tree and let the sidebar show its empty state.
    const mapped = mapError(error)
    if (mapped.kind === 'not_found') return ok({ tree: [], truncated: false })
    return err(mapped)
  }
}

/** Open a file — returns decoded content and its blob sha (for conflicts). */
export async function readFile(
  owner: string,
  repo: string,
  path: string,
): Promise<ActionResult<FileContent>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: MAIN_BRANCH,
    })
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      return err({ kind: 'not_found', message: 'That path is not a file.', status: 404 })
    }
    return ok({ path, content: decodeBase64(data.content), sha: data.sha })
  } catch (error) {
    return err(mapError(error))
  }
}

/** Content of a file at a specific commit (for version history preview). */
export async function readFileAtRef(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<ActionResult<string>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref })
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      return err({ kind: 'not_found', message: 'That path is not a file at this version.', status: 404 })
    }
    return ok(decodeBase64(data.content))
  } catch (error) {
    return err(mapError(error))
  }
}

/** Version history — commits touching a path on main, newest first. */
export async function listFileCommits(
  owner: string,
  repo: string,
  path: string,
): Promise<ActionResult<FileCommit[]>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    const { data } = await octokit.repos.listCommits({
      owner,
      repo,
      path,
      sha: MAIN_BRANCH,
      per_page: 100,
    })
    const commits: FileCommit[] = data.map((c) => ({
      sha: c.sha,
      message: c.commit.message.split('\n')[0] ?? c.commit.message,
      author: c.commit.author?.name ?? c.author?.login ?? 'unknown',
      date: c.commit.author?.date ?? '',
    }))
    return ok(commits)
  } catch (error) {
    return err(mapError(error))
  }
}

/**
 * Delete = commit a removal. Removes each path from `main`, one commit per file
 * (the file's current blob sha is fetched immediately before deletion). Used for
 * both a single file (`paths` of length 1) and a directory (every diagram file
 * beneath it). Missing paths are skipped so a partially-stale tree still cleans
 * up. Uses only the high-level contents API — no git-data ref rewriting.
 */
export async function deletePaths(
  owner: string,
  repo: string,
  paths: string[],
): Promise<ActionResult<{ deleted: number }>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    let deleted = 0
    for (const path of paths) {
      const sha = await getFileSha(octokit, owner, repo, path)
      if (!sha) continue
      await octokit.repos.deleteFile({
        owner,
        repo,
        path,
        message: `Delete ${path} via keep-mermaid`,
        sha,
        branch: MAIN_BRANCH,
      })
      deleted += 1
    }
    return ok({ deleted })
  } catch (error) {
    return err(mapError(error))
  }
}

/** Current blob sha of a file on main, or null if it isn't a plain file. */
async function getFileSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  const { data } = await octokit.repos.getContent({ owner, repo, path, ref: MAIN_BRANCH })
  if (Array.isArray(data) || data.type !== 'file') return null
  return data.sha
}

/**
 * Save = commit. Writes `content` to `path` on main.
 *  - Pass `sha` when updating an existing file (the blob sha you loaded).
 *  - Omit `sha` when creating a new file.
 * A stale sha yields a 409 (mapped to `kind: 'conflict'`), which the client
 * turns into the overwrite / start-over modal.
 */
export async function commitFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  sha?: string,
): Promise<ActionResult<FileContent>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    const message = `${sha ? 'Update' : 'Create'} ${path} via keep-mermaid`
    const { data } = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: encodeBase64(content),
      branch: MAIN_BRANCH,
      ...(sha ? { sha } : {}),
    })
    const newSha = data.content?.sha
    if (!newSha) {
      return err({ kind: 'unknown', message: 'Commit succeeded but returned no sha.' })
    }
    return ok({ path, content, sha: newSha })
  } catch (error) {
    return err(mapError(error))
  }
}
