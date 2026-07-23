import type { AppConfig } from './types'

/**
 * localStorage is the WORKING COPY: uncommitted drafts + app config only.
 * Never store tokens or secrets here (those live in the encrypted session,
 * server-side). GitHub is the committed state.
 */

const CONFIG_KEY = 'km:config'
const DRAFT_PREFIX = 'km:draft:'

/** Stable id for the local-only scratch document (before a repo is connected). */
export const SCRATCH_DOC_ID = 'local:scratch'

/** Stable id for a repo file's draft. Includes branch so the same path on two
 *  different branches never collides on the same draft. */
export function docIdForFile(owner: string, repo: string, branch: string, path: string): string {
  return `${owner}/${repo}@${branch}:${path}`
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

const DEFAULT_CONFIG: AppConfig = {
  repo: null,
  exportBackground: 'white',
  splitRatio: 0.5,
  sidebarWidth: 256,
  mermaidConfig: '',
}

export function loadConfig(): AppConfig {
  if (!hasStorage()) return { ...DEFAULT_CONFIG }
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    const merged = { ...DEFAULT_CONFIG, ...parsed }
    // A repo saved before branch support shipped is missing `branch`/
    // `defaultBranch` — that shape can't drive the branch picker or the PR
    // link, so treat it as disconnected rather than let `undefined` leak into
    // GitHub API calls and URLs. The user just reconnects the repo, which
    // repopulates both fields.
    if (merged.repo && (!merged.repo.branch || !merged.repo.defaultBranch)) {
      merged.repo = null
    }
    // A config saved before the background chooser shipped stores a boolean
    // (paint white vs. transparent) — map it onto the new choice rather than
    // let a stale non-string value reach the export UI.
    if (typeof merged.exportBackground === 'boolean') {
      merged.exportBackground = merged.exportBackground ? 'white' : 'none'
    }
    return merged
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: AppConfig): void {
  if (!hasStorage()) return
  try {
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
  } catch {
    /* quota / disabled storage — ignore */
  }
}

export interface Draft {
  content: string
  updatedAt: number
}

export function loadDraft(docId: string): Draft | null {
  if (!hasStorage()) return null
  try {
    const raw = window.localStorage.getItem(DRAFT_PREFIX + docId)
    return raw ? (JSON.parse(raw) as Draft) : null
  } catch {
    return null
  }
}

export function saveDraft(docId: string, content: string): void {
  if (!hasStorage()) return
  try {
    const draft: Draft = { content, updatedAt: Date.now() }
    window.localStorage.setItem(DRAFT_PREFIX + docId, JSON.stringify(draft))
  } catch {
    /* ignore */
  }
}

export function clearDraft(docId: string): void {
  if (!hasStorage()) return
  try {
    window.localStorage.removeItem(DRAFT_PREFIX + docId)
  } catch {
    /* ignore */
  }
}
