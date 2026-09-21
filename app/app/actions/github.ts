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
 * All GitHub I/O lives here, server-side only. The access token is read from the encrypted session
 * (never from the client) and used to construct Octokit for the duration of a single request.
 */

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data }
}
function err(error: ActionError): ActionResult<never> {
  return { ok: false, error }
}

const UNAUTHENTICATED: ActionError = {
  kind: 'unauthenticated',
  message: 'You are not signed in to GitHub, or your session has expired.',
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
    // 401 covers both "no credentials" and — since the GitHub App migration — "the refresh token
    // was revoked or already spent, so the session can no longer be renewed".
    case 401:
      return {
        kind: 'unauthenticated',
        message: 'Your GitHub session has expired. Please sign in again.',
        status,
      }
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

/** Did the App lose access to this repo, as opposed to hitting a missing ref inside it? */
async function repoAccessLost(octokit: Octokit, owner: string, repo: string): Promise<boolean> {
  try {
    await octokit.repos.get({ owner, repo })
    return false
  } catch (error) {
    return mapError(error).kind === 'not_found'
  }
}

function encodeBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}
function decodeBase64(b64: string): string {
  return Buffer.from(b64.replace(/\n/g, ''), 'base64').toString('utf8')
}

interface BranchSnapshot {
  parentSha: string
  treeSha: string
}

/** Resolve the mutable branch name once; every validation in a transaction uses this commit. */
async function captureBranchSnapshot(
  octokit: Octokit, owner: string, repo: string, branch: string,
): Promise<ActionResult<BranchSnapshot>> {
  let parentSha: string
  try {
    const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` })
    parentSha = ref.data.object.sha
  } catch (error) {
    if ([404, 409].includes(mapError(error).status ?? 0)) {
      return err({
        kind: 'conflict',
        message: 'This branch has no initial commit or no longer exists. Initialize it on GitHub before saving.',
        status: 409,
      })
    }
    throw error
  }
  const parent = await octokit.git.getCommit({ owner, repo, commit_sha: parentSha })
  return ok({ parentSha, treeSha: parent.data.tree.sha })
}

type TreeChange = { path: string; mode: '100644'; type: 'blob'; sha?: string | null; content?: string }

/** Build on the captured tree and advance only when it is still a fast-forward. */
async function commitSnapshot(
  octokit: Octokit, owner: string, repo: string, branch: string,
  snapshot: BranchSnapshot, message: string, changes: TreeChange[],
) {
  const tree = await octokit.git.createTree({ owner, repo, base_tree: snapshot.treeSha, tree: changes })
  const commit = await octokit.git.createCommit({
    owner, repo, message, tree: tree.data.sha, parents: [snapshot.parentSha],
  })
  await octokit.git.updateRef({
    owner, repo, ref: `heads/${branch}`, sha: commit.data.sha, force: false,
  })
  return { tree: tree.data, commitSha: commit.data.sha }
}

/** Is the GitHub session still usable? Called once when the editor mounts. */
export async function checkSession(): Promise<ActionResult<{ valid: true }>> {
  const token = await getGitHubToken()
  if (!token) return err(UNAUTHENTICATED)
  return ok({ valid: true })
}

export interface ReposResult {
  /** The repositories this app can actually read/write, newest activity first. */
  repos: Repo[]
  /** How many installations of the GitHub App the signed-in user can see. */
  installationCount: number
}

/** Repo picker — the repositories the GitHub App installation grants access to. */
export async function listRepos(): Promise<ActionResult<ReposResult>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  try {
    // GET /user/installations
    const installations = await octokit.paginate(
      octokit.apps.listInstallationsForAuthenticatedUser,
      { per_page: 100 },
    )

    const seen = new Set<string>()
    const rows: { repo: Repo; activity: string }[] = []
    let unreadable: ActionError | null = null
    let unreadableCount = 0

    for (const installation of installations) {
      // GET /user/installations/{installation_id}/repositories
      let repos
      try {
        repos = await octokit.paginate(octokit.apps.listInstallationReposForAuthenticatedUser, {
          installation_id: installation.id,
          per_page: 100,
        })
      } catch (error) {
        // One unreadable installation (e.g. suspended by an org admin) must not
        // take down the whole picker — skip it and keep the others. A bad token
        // would already have failed on `/user/installations` above.
        const mapped = mapError(error)
        if (mapped.kind !== 'not_found' && mapped.kind !== 'rate_limited') throw error
        unreadable = mapped
        unreadableCount += 1
        continue
      }
      for (const r of repos) {
        const owner = r.owner?.login
        if (!owner) continue
        const key = `${owner}/${r.name}`.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        rows.push({
          repo: {
            owner,
            name: r.name,
            private: r.private,
            defaultBranch: r.default_branch ?? 'main',
          },
          activity: r.pushed_at ?? r.updated_at ?? '',
        })
      }
    }

    // Every installation failed: an empty picker would read as "you have nothing
    // shared", which is wrong and unactionable. Surface the real error instead.
    if (unreadable && unreadableCount === installations.length) return err(unreadable)

    rows.sort((a, b) => b.activity.localeCompare(a.activity))

    return ok({
      repos: rows.map((row) => row.repo),
      installationCount: installations.length,
    })
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
    // A repo with no commits yet isn't an error here — it just has no files — so surface an empty
    // tree instead of failing the sidebar.
    const mapped = mapError(error)
    if (mapped.status === 409) return ok({ tree: [], truncated: false })
    if (mapped.kind === 'not_found') {
      // Before treating this as "no commits yet", rule out the case where the repo is no longer
      // ours to read at all: an empty tree would render as the ordinary "no files" sidebar, which
      // invites the user to keep working in a repo that will reject every write.
      if (await repoAccessLost(octokit, owner, repo)) {
        return err({
          kind: 'repo_unavailable',
          message: `${owner}/${repo} is no longer available to ${APP_NAME}. It may have been renamed or deleted, or the app's access to it removed on GitHub.`,
          status: 404,
        })
      }
      if (isDefaultBranch) return ok({ tree: [], truncated: false })
    }
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

/** Version history — one page of commits touching `path` on `branch`, newest first. */
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
    // UI pages are slices of one logical stream. Never use the UI page number
    // with a different upstream page size: doing so skips the surplus records.
    const upstreamSize = 100
    const logicalEnd = page * perPage
    const raw: Awaited<ReturnType<typeof octokit.repos.listCommits>>['data'] = []
    let upstreamPage = 1
    let exhausted = false
    while (raw.length <= logicalEnd && !exhausted) {
      const { data } = await octokit.repos.listCommits({
        owner, repo, path, sha: branch, page: upstreamPage, per_page: upstreamSize,
      })
      const fetchedCount = data.length
      if (upstreamPage === 1 && data.length > 0) {
        const newest = data[0]!
        // The path filter also includes the commit that renamed this path away.
        // Remove it once, before display pagination is applied.
        if (await renamedAwayFromPath(octokit, owner, repo, newest.sha, path)) data.shift()
      }
      raw.push(...data)
      exhausted = fetchedCount < upstreamSize
      upstreamPage += 1
    }

    const start = (page - 1) * perPage
    const selected = raw.slice(start, logicalEnd)
    const hasMore = raw.length > logicalEnd || !exhausted
    const commits: FileCommit[] = selected.map((c) => ({
      sha: c.sha,
      message: c.commit.message.split('\n')[0] ?? c.commit.message,
      author: c.commit.author?.name ?? c.author?.login ?? 'unknown',
      date: c.commit.author?.date ?? '',
      path,
    }))

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
 * Delete paths atomically from one captured branch snapshot.
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
    const captured = await captureBranchSnapshot(octokit, owner, repo, branch)
    if (!captured.ok) return captured
    const snapshot = captured.data
    const existing: string[] = []
    for (const path of paths) {
      const present = await octokit.repos.getContent({
        owner, repo, path, ref: snapshot.parentSha,
      }).then(({ data }) => !Array.isArray(data) && data.type === 'file')
        .catch((error: unknown) => {
          if (mapError(error).kind === 'not_found') return false
          throw error
        })
      if (present) existing.push(path)
    }
    if (existing.length === 0) return ok({ deleted: 0 })
    const message = existing.length === 1
      ? `Delete ${existing[0]} via ${APP_NAME}`
      : `Delete ${existing.length} files via ${APP_NAME}`
    await commitSnapshot(octokit, owner, repo, branch, snapshot, message,
      existing.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })))
    return ok({ deleted: existing.length })
  } catch (error) {
    return err(mapError(error))
  }
}

/**
 * Rename (move) a file on `branch`. To keep Git history intact this is done as a single commit that
 * removes the old path and adds the *same blob* at the new path — Git's rename detection then links
 * the two (100% similarity), rather than the orphaned history a delete-then-create (two commits)
 * would produce.
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
    const captured = await captureBranchSnapshot(octokit, owner, repo, branch)
    if (!captured.ok) return captured
    const snapshot = captured.data
    // Old file blob (sha + content) — reused verbatim at the new path.
    const current = await octokit.repos.getContent({ owner, repo, path: oldPath, ref: snapshot.parentSha })
    if (Array.isArray(current.data) || current.data.type !== 'file' || typeof current.data.content !== 'string') {
      return err({ kind: 'not_found', message: 'That path is not a file.', status: 404 })
    }
    const blobSha = current.data.sha
    const content = decodeBase64(current.data.content)

    // Any entry at the destination, including a directory, is a collision.
    try {
      await octokit.repos.getContent({ owner, repo, path: newPath, ref: snapshot.parentSha })
      return err({ kind: 'conflict', message: `${newPath} already exists on GitHub.`, status: 409 })
    } catch (error) {
      if (mapError(error).kind !== 'not_found') throw error
    }

    await commitSnapshot(octokit, owner, repo, branch, snapshot,
      `Rename ${oldPath} → ${newPath} via ${APP_NAME}`, [
        { path: oldPath, mode: '100644', type: 'blob', sha: null },
        { path: newPath, mode: '100644', type: 'blob', sha: blobSha },
      ])

    return ok({ path: newPath, content, sha: blobSha })
  } catch (error) {
    return err(mapError(error))
  }
}

/** Save = commit. Writes `content` to `path` on `branch`. */
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

/** One file in a multi-file commit. `sha` is the blob sha the client loaded, or
 *  undefined for a file that has never been committed. */
export interface FileWrite {
  path: string
  content: string
  sha?: string
}

/** Save everything at once — one commit containing every changed file. */
export async function commitFiles(
  owner: string,
  repo: string,
  files: FileWrite[],
  branch: string,
  message: string,
): Promise<ActionResult<{ commitSha: string; files: FileContent[] }>> {
  const octokit = await getOctokit()
  if (!octokit) return err(UNAUTHENTICATED)
  if (files.length === 0) return err({ kind: 'unknown', message: 'Nothing to commit.' })
  try {
    const captured = await captureBranchSnapshot(octokit, owner, repo, branch)
    if (!captured.ok) return captured
    const snapshot = captured.data
    // Whoever else has been pushing to this branch, a stale sha means the file
    // changed underneath this tab — the same 409 `commitFile` would have raised,
    // raised here before any of the set is written rather than partway through.
    const conflicts: string[] = []
    for (const file of files) {
      // A 404 here is "no such path on the branch", which is a legitimate answer
      // for a file being created. Every other failure is the caller's problem and
      // has to keep its own meaning — swallowing a 401 would read as "absent" and
      // let the commit proceed to fail confusingly further down.
      const current = await octokit.repos.getContent({
        owner, repo, path: file.path, ref: snapshot.parentSha,
      }).then(({ data }) => {
        // A directory or other non-file entry still occupies the destination.
        if (Array.isArray(data) || data.type !== 'file') return '(non-file entry)'
        return data.sha
      }).catch(
        (error: unknown) => {
          if (mapError(error).kind === 'not_found') return null
          throw error
        },
      )
      // Absent on the branch and never loaded by the client: a new file, which is
      // exactly what an undefined `sha` means. Any other mismatch is a conflict,
      // including a file that appeared on the branch under a path this tab thinks
      // it is creating.
      if ((current ?? undefined) !== file.sha) conflicts.push(file.path)
    }
    if (conflicts.length > 0) {
      return err({
        kind: 'conflict',
        message:
          conflicts.length === 1
            ? `${conflicts[0]} changed on GitHub since you loaded it.`
            : `${conflicts.length} files changed on GitHub since you loaded them: ${conflicts.join(', ')}.`,
        status: 409,
      })
    }

    // `content` on a tree entry has GitHub create the blob, so this is one request
    // rather than one `createBlob` per file. Text only, which every kind here is.
    const { tree, commitSha } = await commitSnapshot(
      octokit, owner, repo, branch, snapshot, message,
      files.map((file) => ({
        path: file.path,
        mode: '100644' as const,
        type: 'blob' as const,
        content: file.content,
      })),
    )

    // The new blob shas, so the client can update each file's baseline without a
    // round trip per file. Read back off the created tree, which already lists
    // every entry it holds.
    const written = new Map(
      tree.tree
        .filter((entry) => typeof entry.path === 'string' && typeof entry.sha === 'string')
        .map((entry) => [entry.path as string, entry.sha as string]),
    )
    return ok({
      commitSha,
      files: files.map((file) => ({
        path: file.path,
        content: file.content,
        // A tree built with `base_tree` lists the entries it *changed*, which is
        // every file here — but falling back to the loaded sha keeps a missing
        // entry from writing `undefined` into a baseline.
        sha: written.get(file.path) ?? file.sha ?? '',
      })),
    })
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

/** Create a new branch pointing at the current tip of `fromBranch`. */
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
