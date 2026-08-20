/**
 * The wire contract between the MCP server process and the browser tab.
 *
 * Imported by BOTH sides — `mcp/` (node) and `lib/agentLink.ts` (browser) — so
 * it must stay types and constants only, with no imports of its own. Same
 * discipline as `lib/diff.ts`: no React, no I/O, nothing environment-specific.
 * A value import here would drag node types into the client bundle or DOM types
 * into the MCP program, and the two compile under different tsconfigs.
 *
 * Direction of the socket is worth restating because it is the opposite of what
 * most people assume: the **MCP process listens** and the **browser dials out**.
 * A web page cannot open a listening socket, so this is forced rather than
 * chosen (see CLAUDE.md "Agent Link").
 */

/** Bumped on any breaking change to the frames below. The tab sends it with the
 *  auth frame and a mismatch is refused with a message naming both versions,
 *  because the alternative — a subtly wrong field — surfaces as an inexplicable
 *  tool failure much later. */
export const PROTOCOL_VERSION = 2

/** `aud` of the connection token. Pinned on the MCP side so a token minted for
 *  some other purpose by the same key can't be replayed at the bridge. */
export const TOKEN_AUDIENCE = 'ideate-mcp'

/** Path the tab mints its connection token from. Returns JSON with no CORS
 *  headers — that omission is the security property (only same-origin JS can
 *  read the response), not an oversight. */
export const TOKEN_ENDPOINT = '/api/agent/token'

/** Where each trusted issuer publishes its Ed25519 public key. A plain route
 *  rather than a `/.well-known/` path: Next treats a dot-prefixed `app/`
 *  directory as hidden, so serving it there would need a rewrite for no gain —
 *  this is our own protocol, not a registered well-known URI. */
export const JWKS_PATH = '/api/agent/jwks'

/**
 * The loopback ports the bridge lives on — the single shared fact that lets the
 * two sides find each other with nothing configured.
 *
 * A range rather than one port, because one bridge serves one tab: a second agent
 * session needs a port of its own, and 7391 may simply be taken by something
 * else. The MCP binds the first free one; the tab dials them **in rotation across
 * reconnect attempts**, so the ordinary case touches 7391 and stops. That is
 * deliberately not a parallel scan — probing a range at once from a web page is
 * the behaviour Chrome's Local Network Access work exists to discourage.
 *
 * Neither side reads this from the environment. An env override on the MCP could
 * bind a port the tab never dials, which presents as "the agent cannot see my
 * editor" with nothing to point at; one constant means they agree by construction.
 */
export const BRIDGE_PORTS: readonly number[] = [7391, 7392, 7393, 7394, 7395]

/** How long a connection may stay unauthenticated. The socket is accepted, then
 *  closed if no valid `auth` frame arrives — the browser WebSocket API cannot set
 *  request headers, so the token has to travel in-band. */
export const AUTH_DEADLINE_MS = 2_000

/** Per-command timeout. Generous, because a command can be waiting on a GitHub
 *  read through the tab. */
export const REQUEST_TIMEOUT_MS = 15_000

/** Frames larger than this are dropped and the socket closed. A scene JSON is
 *  the biggest legitimate payload and is nowhere near this. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

/* ------------------------------------------------------------------ */
/* Commands (MCP → tab)                                                */
/* ------------------------------------------------------------------ */

/** One anchored replacement. Deliberately string-anchored rather than
 *  offset-based: an agent reasons in terms of the text it just read, and an
 *  offset computed against a document the human has since edited silently
 *  corrupts the file, whereas a stale `oldText` fails loudly. */
export interface TextEdit {
  oldText: string
  newText: string
  /** Replace every occurrence. Without it, `oldText` matching more than once is
   *  an error rather than a coin flip over which one was meant. */
  replaceAll?: boolean
}

export type SceneElementType = 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'arrow' | 'line'

export interface SceneAddOp {
  op: 'add'
  /** Caller-chosen id, so later ops in the same batch can bind to this element
   *  and a follow-up call can update it. Generated when omitted. */
  id?: string
  type: SceneElementType
  x: number
  y: number
  width?: number
  height?: number
  /** For `text`, the content. For a shape, a bound label centred inside it. */
  text?: string
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: 'hachure' | 'cross-hatch' | 'solid'
  strokeWidth?: number
  roughness?: number
  /** Arrow/line endpoints, as element ids. Either may name something already on
   *  the canvas or something created in the same call — `lib/sceneEdit.ts` routes
   *  the arrow between the two boxes itself and wires the binding both ways, so
   *  the distinction does not reach the caller. */
  start?: string
  end?: string
  /** Explicit geometry for an unbound arrow/line, relative to `x`/`y`. Objects
   *  rather than `[x, y]` pairs: a tool schema an LLM fills in reliably beats one
   *  that mirrors Excalidraw's internal tuple, and the conversion is one `map`. */
  points?: Array<{ x: number; y: number }>
}

export interface SceneUpdateOp {
  op: 'update'
  id: string
  x?: number
  y?: number
  width?: number
  height?: number
  /** Rewrites the element's own text, or its bound label if it has one. */
  text?: string
  strokeColor?: string
  backgroundColor?: string
}

export interface SceneDeleteOp {
  op: 'delete'
  id: string
}

export type SceneOp = SceneAddOp | SceneUpdateOp | SceneDeleteOp

export type Command =
  | { cmd: 'status' }
  | { cmd: 'list_files' }
  | { cmd: 'read'; path?: string }
  | { cmd: 'edit'; edits: TextEdit[] }
  | { cmd: 'write'; text: string }
  | { cmd: 'open'; path: string }
  | { cmd: 'create_file'; path: string; content?: string }
  | { cmd: 'check' }
  | { cmd: 'scene_get'; full?: boolean }
  | { cmd: 'scene_edit'; ops: SceneOp[] }

export type CommandName = Command['cmd']

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/** Mirrors `FileKind` in `lib/tree.ts`, spelled out here so the protocol module
 *  keeps its no-imports rule. */
export type DocKind = 'mermaid' | 'markdown' | 'excalidraw'

/** Pushed by the tab whenever the answer changes, so `ideate_status` is accurate
 *  without a round trip and the MCP can reject a text tool aimed at a scene
 *  before spending one. */
export interface BridgeState {
  mode: 'github' | 'local'
  repo: { owner: string; name: string; branch: string; defaultBranch: string } | null
  openPath: string | null
  kind: DocKind
  dirty: boolean
  lineCount: number
  charCount: number
}

export interface StatusResult extends BridgeState {
  /** 1-based, and absent when the surface has no cursor (the canvas). */
  cursor: { line: number; column: number } | null
  /** Files in the connected repo, or null in local mode. */
  fileCount: number | null
  protocol: number
}

/** A problem the *renderer* found — the thing an agent editing a diagram cannot
 *  get from editing files on disk, and the reason this bridge exists. */
export interface Diagnostic {
  /** Which mermaid block, for a markdown document with several fences. */
  label: string | null
  message: string
}

export interface EditResult {
  /** Number of edits applied. Always `edits.length` — a partial apply is never
   *  reported, because every edit is resolved before any is dispatched. */
  applied: number
  lineCount: number
  diagnostics: Diagnostic[]
}

export interface ReadResult {
  path: string | null
  text: string
  /** False for the open document (the uncommitted working copy), true when a
   *  `path` was given and the committed content was fetched from GitHub. */
  committed: boolean
}

export interface ListFilesResult {
  paths: string[]
}

export interface CheckResult {
  diagnostics: Diagnostic[]
}

export interface SceneElementSummary {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  text: string | null
}

export interface SceneGetResult {
  elementCount: number
  elements: SceneElementSummary[]
  /** Only when `full` was requested — the entire scene file. Large. */
  json?: string
}

export interface SceneEditResult {
  applied: number
  elementCount: number
}

/* ------------------------------------------------------------------ */
/* Frames                                                              */
/* ------------------------------------------------------------------ */

export type ServerFrame =
  /** The auth frame verified and this tab now holds the bridge. **Not** "an agent
   *  can edit this document" — that needs `attached` below. Until `ready` arrives
   *  the tab must not report success at all, or a rejected token would look like a
   *  working link. */
  | { t: 'ready' }
  /** An agent has deliberately attached to this tab (`ideate_connect`), and only
   *  now can it read or change the document. Kept separate from `ready` because a
   *  server being up is not a decision anybody made: the MCP process starts with
   *  the agent session, so adopting whatever tab was waiting would let an agent
   *  begin editing with nobody having chosen it. */
  | { t: 'attached'; agent: string | null }
  /** The agent let go — it called `ideate_disconnect`, or its session ended. The
   *  socket stays up and the tab keeps holding the bridge. */
  | { t: 'detached' }
  | { t: 'req'; id: number; command: Command }

export type ClientFrame =
  | { t: 'auth'; token: string; protocol: number }
  | { t: 'res'; id: number; ok: true; data: unknown }
  | { t: 'res'; id: number; ok: false; message: string }
  | { t: 'event'; name: 'state'; state: BridgeState }

/** Close codes. 4001–4009 is the private-use range, so these can't collide with
 *  the protocol's own codes and the tab can tell "rejected" from "server went
 *  away" — which decides whether reconnecting is pointless or expected. */
export const CLOSE_UNAUTHORIZED = 4001
export const CLOSE_PROTOCOL_MISMATCH = 4002
export const CLOSE_SLOT_TAKEN = 4003
export const CLOSE_FRAME_TOO_LARGE = 4004
