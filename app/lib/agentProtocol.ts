/**
 * The wire contract between the Agent Link service and the browser tab.
 *
 * Imported by the app, and **mirrored by hand in Go** (`ideate-mcp/internal/protocol`).
 * The compiler used to enforce the old two-consumer rule; nothing does now, so the
 * guard is a set of golden JSON frames in `ideate-mcp/testdata/frames/` that both
 * sides parse — the Go tests round-trip them, and `lib/agentFrames.fixtures.ts`
 * type-checks them against the declarations below. A frame added without a fixture
 * is a frame that can drift silently.
 *
 * Direction of the socket, and who listens, changed in protocol 3. The MCP server
 * used to run on the user's machine and *listen* on loopback while the tab dialled
 * out to it. That could not work at all in Safari — no loopback exemption for mixed
 * content, so `ws://127.0.0.1` from an `https://` page is simply blocked — and it
 * confined the whole feature to an agent on the same machine as the browser.
 *
 * Now one remote Go service is **both** the MCP server and the relay:
 *
 *     agent ──MCP Streamable HTTP──► service ──WebSocket──► browser tab
 *
 * The tab is still the WebSocket client, but it dials the service rather than
 * loopback, and a **pairing code** the tab generates (and the human hands to their
 * agent) is what joins the two halves. Everything the old design needed to make a
 * loopback listener safe — the port walk, the `Origin` allowlist as a security
 * control, the whole JWT/JWKS apparatus — is gone with it.
 */

/** Bumped on any breaking change to the frames below. The tab sends it with the
 *  hello frame and a mismatch is refused with a message naming both versions,
 *  because the alternative — a subtly wrong field — surfaces as an inexplicable
 *  tool failure much later.
 *
 *  3: the loopback bridge became a remote relay (see above). Deliberately a
 *  one-way break: an old `npx github:` install and a new app refuse each other.
 *
 *  4: every document command takes an optional `path`. The tools stopped meaning
 *  "the open document" and started meaning "a document in the repo, the open one
 *  by default" — see `Command` below. A break rather than an additive change
 *  because the *results* grew fields too, and a tab that answers `edit` without
 *  saying which document it edited is exactly the ambiguity the path introduces. */
export const PROTOCOL_VERSION = 4

/** Where the tab opens its WebSocket, under the configured service origin. */
export const TAB_PATH = '/v1/tab'

/** Capacity probe. A plain GET answering `{live, max}`, and **529** when full.
 *
 *  It exists because a *refused* WebSocket handshake cannot carry a status code to
 *  a browser: a rejected upgrade surfaces in the tab as `onclose` 1006 with an
 *  empty reason, indistinguishable from the service being down. So the tab learns
 *  it is capacity, not an outage, from a `CLOSE_SERVICE_FULL` on an **accepted**
 *  socket — and this route is where a non-browser client can read the 529 that a
 *  browser never gets to see. */
export const CAPACITY_PATH = '/v1/capacity'

/** Crockford base32, so a code can be read aloud down a corridor: no I, L, O or U,
 *  which removes every 1/l/I and 0/O confusion and the one accidental obscenity. */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 8 characters — 2^40 of search space against the service's unknown-code limiter,
 *  and still short enough to say out loud. Displayed as `XXXX-XXXX`; the service
 *  normalizes case and strips the separator, so either form works when the human
 *  types it at their agent. */
export const PAIRING_CODE_LENGTH = 8

/** How long a socket may stay un-paired. The tab is accepted, then closed if no
 *  valid `hello` frame arrives — a browser WebSocket cannot set request headers, so
 *  the code has to travel in-band as the first frame. */
export const HELLO_DEADLINE_MS = 2_000

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

/**
 * The union of everything the tab can be asked to do.
 *
 * **Every command that names a document takes a `path`.** That is the whole of
 * protocol 4, and it is a bigger change than one field: until then the tool surface
 * was "whatever the human is looking at", so an agent asked to fix six diagrams had
 * to `open` each one — which yanks the human's editor to a different file six
 * times, and loses their cursor each time. With a path the same work never touches
 * what is on screen.
 *
 * Where the field is *optional* differs by what the command does, and the split is
 * deliberate:
 *
 * - **`read`, `check` and `scene_get` may omit it**, and then mean the open
 *   document. "What is on screen" is a legitimate question, and answering it about
 *   the wrong document costs a wasted call.
 * - **`edit`, `write` and `scene_edit` must carry one** whenever a file is open.
 *   The open document is not a stable address: the human browses their files while
 *   the agent works, so a mutation aimed at "the open document" is aimed at whatever
 *   they happened to click last, and it is not recoverable by reading again. The tab
 *   refuses those, naming the tool that reports the open path. The type keeps the
 *   field optional for the one document that has no path to carry — the **untitled**
 *   one, before it has been saved anywhere. That is a state of the tab rather than a
 *   mode of the app: local mode has files of its own, and a connected repository
 *   still has an untitled document. The tab is the only side that knows.
 *
 * What a path does *not* buy is a second way to reach the open document. When it
 * names the file already open, the tab routes the command through the live editor
 * exactly as an omitted path would, or the human's undo history and cursor would
 * depend on which spelling the agent happened to pick.
 *
 * `open` and `create_file` have always required a path, because a command whose
 * entire purpose is to change *which* document is open cannot default to the
 * current one.
 */
export type Command =
  | { cmd: 'status' }
  | { cmd: 'list_files' }
  | { cmd: 'read'; path?: string }
  | { cmd: 'edit'; path?: string; edits: TextEdit[] }
  | { cmd: 'write'; path?: string; text: string }
  | { cmd: 'open'; path: string }
  | { cmd: 'create_file'; path: string; content?: string }
  | { cmd: 'check'; path?: string }
  | { cmd: 'scene_get'; path?: string; full?: boolean }
  | { cmd: 'scene_edit'; path?: string; ops: SceneOp[] }

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
  /** How many files `list_files` would return. Null only when there is no file
   *  workspace at all — signed in with no repository picked. Local mode counts,
   *  because local mode has files: `repo === null` no longer implies there is
   *  nothing to list. */
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

/** Which document a command actually acted on, and whether it had to invent it.
 *
 *  Echoed on every mutating result rather than left implicit, because from
 *  protocol 4 the agent's request no longer determines the answer on its own: an
 *  omitted `path` resolves against whatever the human has open *at that moment*,
 *  and a path that matched nothing resolves to a file that did not exist a moment
 *  ago. Both are things the agent has to be told rather than assume. */
export interface Touched {
  /** The path acted on. Null only for the untitled document, which has none until
   *  the human saves it somewhere. */
  path: string | null
  /** The path named no file the workspace had — no commit on the branch, no local
   *  file, no draft — so it was created as an unsaved document. Nothing was pushed
   *  to GitHub: the human still has to save it, exactly as with `create_file`. */
  created: boolean
}

export interface EditResult extends Touched {
  /** Number of edits applied. Always `edits.length` — a partial apply is never
   *  reported, because every edit is resolved before any is dispatched. */
  applied: number
  lineCount: number
  diagnostics: Diagnostic[]
}

export interface ReadResult {
  path: string | null
  text: string
  /** True when what came back is byte-for-byte (drawing-for-drawing, for a scene)
   *  what the branch has committed.
   *
   *  Not "did you pass a path": a path whose file has uncommitted edits in this
   *  browser answers with *those*, because the working copy is the thing the human
   *  is looking at and the thing the next commit will carry. Reading committed
   *  bytes past an edit somebody made — an agent's own edit, one call earlier — is
   *  how an agent talks itself into re-applying work it has already done. */
  committed: boolean
}

export interface ListFilesResult {
  paths: string[]
}

export interface CheckResult {
  /** Which document was checked, for the same reason `Touched` carries it. */
  path: string | null
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
  path: string | null
  elementCount: number
  elements: SceneElementSummary[]
  /** Only when `full` was requested — the entire scene file. Large. */
  json?: string
}

export interface SceneEditResult extends Touched {
  applied: number
  elementCount: number
}

/* ------------------------------------------------------------------ */
/* Frames                                                              */
/* ------------------------------------------------------------------ */

export type ServerFrame =
  /** The hello was accepted and this tab now holds the bucket for its code. **Not**
   *  "an agent can edit this document" — that needs `attached` below. Until `ready`
   *  arrives the tab must not report success at all, or a refused code would look
   *  like a working link. */
  | { t: 'ready' }
  /** An agent has deliberately attached to this tab (`ideate_connect`), and only
   *  now can it read or change the document. Kept separate from `ready` because a
   *  paired tab is not a decision anybody made about *driving* it: pairing says
   *  which tab, attaching says whether. Also re-sent when a tab rejoins its bucket
   *  inside the grace window while an agent still holds it, so a reload does not
   *  leave the toolbar claiming nobody is attached. */
  | { t: 'attached'; agent: string | null }
  /** The agent let go — it called `ideate_disconnect`, or its attachment idled out.
   *  The socket stays up and the tab keeps holding its bucket. */
  | { t: 'detached' }
  | { t: 'req'; id: number; command: Command }

export type ClientFrame =
  /** First frame, inside `HELLO_DEADLINE_MS`. The code is the credential; it travels
   *  in-band because a browser WebSocket cannot set request headers. */
  | { t: 'hello'; code: string; protocol: number }
  | { t: 'res'; id: number; ok: true; data: unknown }
  | { t: 'res'; id: number; ok: false; message: string }
  | { t: 'event'; name: 'state'; state: BridgeState }

/** Close codes. 4001–4009 is the private-use range, so these can't collide with the
 *  protocol's own codes and the tab can tell "refused" from "the service went away"
 *  — which decides whether reconnecting is pointless, worth retrying, or worth
 *  retrying only when a human asks. */

/** No hello frame, or a malformed one, inside the deadline. */
export const CLOSE_BAD_HELLO = 4001
/** Retrying cannot fix this: the two sides were built against different versions. */
export const CLOSE_PROTOCOL_MISMATCH = 4002
/** Another tab already holds this code's bucket. */
export const CLOSE_SLOT_TAKEN = 4003
export const CLOSE_FRAME_TOO_LARGE = 4004
/** The service is at `MAX_WS_SESSIONS`. Delivered on an *accepted* socket rather
 *  than as a refused handshake, because a refused handshake reaches a browser as an
 *  anonymous 1006 — see `CAPACITY_PATH`. The reason names the self-host option, and
 *  the tab stops its automatic retry loop on it: capacity does free up, so retrying
 *  is not pointless, but hammering a full service is not the way to wait for it. */
export const CLOSE_SERVICE_FULL = 4005
