'use server'

import { Octokit } from '@octokit/rest'
import { getGitHubToken } from '@/lib/session.server'
import { APP_NAME } from '@/lib/config'
import { buildTree, isDiagramFile } from '@/lib/tree'
import type {
  ActionError,
  ActionResult,
  Branch,
  FileCommit,
  FileCommitsPage,
  FileContent,
  Repo,
  TreeNode,
} from '@/lib/types'

/**
 * All GitHub I/O lives here, server-side only. The access token is read from the
 * encrypted session (never from the client) and used to construct Octokit for
 * the duration of a single request.
 *
 * Every read/write action takes the caller-supplied `branch` to operate on —
 * there is no fixed branch; the client tracks which one is selected.
 */

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
      defaultBranch: r.default_branch ?? 'main',
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
  branch: string,
  isDefaultBranch: boolean,
): Promise<ActionResult<TreeResult>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    const { data } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: branch,
      recursive: 'true',
    })
    const filePaths = data.tree
      .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
      .map((entry) => entry.path as string)
      .filter(isDiagramFile)
    return ok({ tree: buildTree(filePaths), truncated: Boolean(data.truncated) })
  } catch (error) {
    // An empty repo (no commits on its default branch yet) 404s here — that
    // isn't an error, it just means there are no files yet, so surface an empty
    // tree. A 404 on a *non-default* branch more likely means the branch was
    // deleted/mistyped, so only swallow the 404 for the default branch.
    const mapped = mapError(error)
    if (isDefaultBranch && mapped.kind === 'not_found') return ok({ tree: [], truncated: false })
    return err(mapped)
  }
}

/** Open a file — returns decoded content and its blob sha (for conflicts). */
export async function readFile(
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<ActionResult<FileContent>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
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

/**
 * Version history — one page of commits touching `path` on `branch`, newest first.
 *
 * The REST commits API does not follow renames, so a path's history stops dead at
 * the commit that created it under that name. Rather than eagerly walking the whole
 * rename chain (which can mean an unbounded number of `listCommits`/`getCommit` calls
 * for a long-lived, oft-renamed file), each call here only ever fetches one page of
 * one path segment. Only once the *last* page of a segment is reached do we check
 * whether its earliest commit renamed the file in from an older path (GitHub reports
 * `previous_filename`) — the caller decides whether to page into that older path,
 * surfaced as `renamedFrom` so the UI can offer it as an explicit "view history
 * before rename" action instead of silently merging it in.
 */
export async function listFileCommits(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  page = 1,
  perPage = 30,
): Promise<ActionResult<FileCommitsPage>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    // The commits API's path filter is a tree-diff, so it also matches the commit
    // that renamed `path` AWAY to somewhere else (its tree entry at `path` changed
    // too — to "absent"). That commit only ever shows up as the newest entry of
    // page 1, dated after everything that actually lived at `path`. Fetch one
    // extra up front so removing it doesn't cost us the `hasMore` page boundary.
    const fetchSize = page === 1 ? perPage + 2 : perPage + 1
    const { data } = await octokit.repos.listCommits({
      owner,
      repo,
      path,
      sha: branch,
      page,
      per_page: fetchSize,
    })

    let raw = data
    if (page === 1 && raw.length > 0) {
      const newest = raw[0]!
      if (await renamedAwayFromPath(octokit, owner, repo, newest.sha, path)) {
        raw = raw.slice(1)
      }
    }

    const hasMore = raw.length > perPage
    const commits: FileCommit[] = raw.slice(0, perPage).map((c) => ({
      sha: c.sha,
      message: c.commit.message.split('\n')[0] ?? c.commit.message,
      author: c.commit.author?.name ?? c.author?.login ?? 'unknown',
      date: c.commit.author?.date ?? '',
      path,
    }))

    // Only the last page of a segment can reveal a rename into `path` — every
    // earlier page is newer than the segment's earliest (renaming) commit.
    let renamedFrom: string | null = null
    if (!hasMore && commits.length > 0) {
      const earliest = commits[commits.length - 1]!
      renamedFrom = await renamedFromPath(octokit, owner, repo, earliest.sha, path)
    }

    return ok({ commits, hasMore, renamedFrom })
  } catch (error) {
    return err(mapError(error))
  }
}

/** True if commit `sha` renamed the file at `path` away to a different path —
 *  i.e. `path`'s content no longer exists there as of this commit. */
async function renamedAwayFromPath(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  path: string,
): Promise<boolean> {
  const { data } = await octokit.repos.getCommit({ owner, repo, ref: sha })
  return !!data.files?.some(
    (f) => f.previous_filename === path && f.status === 'renamed' && f.filename !== path,
  )
}

/** If commit `sha` renamed a file into `path`, the file's previous path, else null. */
async function renamedFromPath(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  path: string,
): Promise<string | null> {
  const { data } = await octokit.repos.getCommit({ owner, repo, ref: sha })
  const renamed = data.files?.find(
    (f) => f.filename === path && f.status === 'renamed' && f.previous_filename,
  )
  return renamed?.previous_filename ?? null
}

/**
 * Delete = commit a removal. Removes each path from `branch`, one commit per
 * file (the file's current blob sha is fetched immediately before deletion).
 * Used for both a single file (`paths` of length 1) and a directory (every
 * diagram file beneath it). Missing paths are skipped so a partially-stale tree
 * still cleans up. Uses only the high-level contents API — no git-data ref
 * rewriting.
 */
export async function deletePaths(
  owner: string,
  repo: string,
  paths: string[],
  branch: string,
): Promise<ActionResult<{ deleted: number }>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    let deleted = 0
    for (const path of paths) {
      const sha = await getFileSha(octokit, owner, repo, path, branch)
      if (!sha) continue
      await octokit.repos.deleteFile({
        owner,
        repo,
        path,
        message: `Delete ${path} via ${APP_NAME}`,
        sha,
        branch,
      })
      deleted += 1
    }
    return ok({ deleted })
  } catch (error) {
    return err(mapError(error))
  }
}

/**
 * Rename (move) a file on `branch`. To keep Git history intact this is done as
 * a single commit that removes the old path and adds the *same blob* at the new
 * path — Git's rename detection then links the two (100% similarity), rather
 * than the orphaned history a delete-then-create (two commits) would produce.
 *
 * This uses the git-data API to build one tree + commit, then fast-forwards the
 * branch ref (force: false). That is a normal ref advance, not the ref-rewrite /
 * force-push that the overwrite-on-conflict flow forbids.
 */
export async function renameFile(
  owner: string,
  repo: string,
  oldPath: string,
  newPath: string,
  branch: string,
): Promise<ActionResult<FileContent>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  if (oldPath === newPath) return err({ kind: 'unknown', message: 'The path is unchanged.' })
  try {
    // Old file blob (sha + content) — reused verbatim at the new path.
    const current = await octokit.repos.getContent({ owner, repo, path: oldPath, ref: branch })
    if (Array.isArray(current.data) || current.data.type !== 'file' || typeof current.data.content !== 'string') {
      return err({ kind: 'not_found', message: 'That path is not a file.', status: 404 })
    }
    const blobSha = current.data.sha
    const content = decodeBase64(current.data.content)

    const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` })
    const parentSha = ref.data.object.sha
    const parentCommit = await octokit.git.getCommit({ owner, repo, commit_sha: parentSha })

    const tree = await octokit.git.createTree({
      owner,
      repo,
      base_tree: parentCommit.data.tree.sha,
      tree: [
        { path: oldPath, mode: '100644', type: 'blob', sha: null }, // remove old
        { path: newPath, mode: '100644', type: 'blob', sha: blobSha }, // add same blob
      ],
    })

    const commit = await octokit.git.createCommit({
      owner,
      repo,
      message: `Rename ${oldPath} → ${newPath} via ${APP_NAME}`,
      tree: tree.data.sha,
      parents: [parentSha],
    })

    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: commit.data.sha,
      force: false,
    })

    return ok({ path: newPath, content, sha: blobSha })
  } catch (error) {
    return err(mapError(error))
  }
}

/** Current blob sha of a file on `branch`, or null if it isn't a plain file. */
async function getFileSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<string | null> {
  const { data } = await octokit.repos.getContent({ owner, repo, path, ref: branch })
  if (Array.isArray(data) || data.type !== 'file') return null
  return data.sha
}

/**
 * Save = commit. Writes `content` to `path` on `branch`.
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
  branch: string,
  sha?: string,
): Promise<ActionResult<FileContent>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    const message = `${sha ? 'Update' : 'Create'} ${path} via ${APP_NAME}`
    const { data } = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: encodeBase64(content),
      branch,
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

/** Branch switcher — every branch in the repo. */
export async function listBranches(
  owner: string,
  repo: string,
): Promise<ActionResult<Branch[]>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    const branches = await octokit.paginate(octokit.repos.listBranches, {
      owner,
      repo,
      per_page: 100,
    })
    return ok(branches.map((b) => ({ name: b.name, protected: b.protected })))
  } catch (error) {
    return err(mapError(error))
  }
}

/**
 * Create a new branch pointing at the current tip of `fromBranch`. Just a ref
 * create (no commit) — the new branch's tree is identical to its source until
 * the next save.
 */
export async function createBranch(
  owner: string,
  repo: string,
  name: string,
  fromBranch: string,
): Promise<ActionResult<{ name: string }>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${fromBranch}` })
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${name}`,
      sha: ref.data.object.sha,
    })
    return ok({ name })
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: number }).status
        : undefined
    // GitHub's generic "stale sha" conflict copy (from mapError) would be
    // misleading here — a 422 on ref creation means the branch already exists.
    if (status === 422) {
      return err({ kind: 'conflict', message: `A branch named "${name}" already exists.`, status })
    }
    return err(mapError(error))
  }
}
