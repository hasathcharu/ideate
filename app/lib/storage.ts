import type { AppConfig } from './types'
import type { FileKind } from './tree'
import { validateRelayOrigin } from './relayOrigin'

/**
 * localStorage is the WORKING COPY: uncommitted drafts + app config only.
 * Never store tokens or secrets here (those live in the encrypted session,
 * server-side). GitHub is the committed state.
 */

const CONFIG_KEY = 'km:config'
const DRAFT_PREFIX = 'km:draft:'

/** Stable id for the local-only scratch document (before a repo is connected). */
export const SCRATCH_DOC_ID = 'local:scratch'

/** Scratch slot for an Excalidraw canvas. Deliberately separate from
 *  `SCRATCH_DOC_ID`: the kinds hold incompatible content, so giving each its
 *  own draft means toggling between them in local mode preserves all of them
 *  rather than overwriting one with the other. */
export const SCRATCH_SCENE_DOC_ID = 'local:scratch-scene'

/** Scratch slot for a markdown document — same reasoning as the scene slot. */
export const SCRATCH_MARKDOWN_DOC_ID = 'local:scratch-markdown'

/** The scratch draft slot for `kind`. Every caller that parks or restores the
 *  unsaved scratch document goes through this, so a new kind can never end up
 *  sharing another kind's slot. */
export function scratchDocIdFor(kind: FileKind): string {
  switch (kind) {
    case 'excalidraw':
      return SCRATCH_SCENE_DOC_ID
    case 'markdown':
      return SCRATCH_MARKDOWN_DOC_ID
    case 'mermaid':
      return SCRATCH_DOC_ID
  }
}

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
  wrapLines: false,
  minimap: true,
  scratchKind: 'mermaid',
  relayOrigin: null,
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
    // A relay origin that no longer passes the TLS rule is dropped back to the
    // default rather than kept. It is the same defensive shape as the two guards
    // above, and it matters more: an unusable origin here is not a cosmetic
    // fallback but a tab that cannot connect at all, with the reason buried in
    // localStorage where nobody would think to look.
    if (typeof merged.relayOrigin === 'string' && validateRelayOrigin(merged.relayOrigin)) {
      merged.relayOrigin = null
    }
    // A build that stored `agentLink` in here left a stray key behind. Drop it, or
    // an old `true` would keep arming tabs that never asked — the exact behaviour
    // moving it to sessionStorage exists to stop.
    delete (merged as Record<string, unknown>).agentLink
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

/* ------------------------------------------------------------------ */
/* Agent Link — per tab, not per origin                                */
/* ------------------------------------------------------------------ */

/**
 * Whether *this tab* offers itself to the Agent Link service, and under which
 * pairing code.
 *
 * `sessionStorage`, not `localStorage`, and deliberately not part of `AppConfig`:
 * config is shared by every tab on the origin, so persisting either of these there
 * meant one switch armed every tab that opened afterwards. All of them would then
 * race for the relay and whichever won became the tab an agent drove — leaving the
 * human no way to choose. Per-tab scoping makes "switch it on here" mean this tab,
 * and gives each tab a code of its own to be named by.
 *
 * Both survive a reload, which matters on each count: a refresh mid-session should
 * not silently drop the link, and it should come back under the *same* code, or the
 * agent is left holding one that no longer reaches anything.
 *
 * Where the service lives is the opposite kind of fact and lives in `AppConfig`
 * instead — see the comment block in lib/types.ts.
 */
const AGENT_LINK_KEY = 'km:agent-link'

function hasSessionStorage(): boolean {
  return typeof window !== 'undefined' && !!window.sessionStorage
}

export function loadAgentLink(): boolean {
  if (!hasSessionStorage()) return false
  try {
    return window.sessionStorage.getItem(AGENT_LINK_KEY) === 'on'
  } catch {
    return false
  }
}

export function saveAgentLink(enabled: boolean): void {
  if (!hasSessionStorage()) return
  try {
    if (enabled) window.sessionStorage.setItem(AGENT_LINK_KEY, 'on')
    else window.sessionStorage.removeItem(AGENT_LINK_KEY)
  } catch {
    /* quota / disabled storage — ignore */
  }
}

/** This tab's pairing code, canonical (uppercase, no separator). Never a token —
 *  it is a name the human reads aloud, and the service holds nothing durable that
 *  it unlocks. */
const PAIRING_CODE_KEY = 'km:agent-code'

export function loadPairingCode(): string | null {
  if (!hasSessionStorage()) return null
  try {
    return window.sessionStorage.getItem(PAIRING_CODE_KEY)
  } catch {
    return null
  }
}

export function savePairingCode(code: string | null): void {
  if (!hasSessionStorage()) return
  try {
    if (code) window.sessionStorage.setItem(PAIRING_CODE_KEY, code)
    else window.sessionStorage.removeItem(PAIRING_CODE_KEY)
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
