/** The wire contract between the Agent Link service and the browser tab. */

/** Bumped on any breaking change to the frames below. */
export const PROTOCOL_VERSION = 7

/** Where the tab opens its WebSocket, under the configured service origin. */
export const TAB_PATH = '/v1/tab'

/** Capacity probe. A plain GET answering `{live, max}`, and **529** when full. */
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
 *  the biggest legitimate payload and is nowhere near this — and a `scene_render`
 *  answer, the only *binary* one, is held below `SCENE_RENDER_MAX_BYTES` by the tab
 *  precisely so this limit never becomes the thing that catches it. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** Longest edge of a `scene_render` image, in pixels. */
export const SCENE_RENDER_LONG_EDGE = 1024

/** The same, for a canvas dense enough that the first encode came out too big.
 *  Deliberately far below the cap rather than a notch under it: a scene that
 *  overflows at 1024 is dense, and shaving 10% off would only spend a second encode
 *  to fail again. */
export const SCENE_RENDER_FALLBACK_LONG_EDGE = 640

/**
 * Ceiling on the encoded image the tab will put on the socket, well under `MAX_FRAME_BYTES` so that
 * a huge drawing is answered by a smaller picture rather than by a closed socket.
 */
export const SCENE_RENDER_MAX_BYTES = 512 * 1024

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

export type ExpectedRevision = number | 'absent'

export interface ReadManyRequest {
  path: string
  startLine?: number
  endLine?: number
}

export interface RevisionExpectation {
  path: string
  revision: ExpectedRevision
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

/** Line several elements up on one edge, or on a centre line. */
export interface SceneAlignOp {
  op: 'align'
  /** Two or more element ids. Anything bound to them — labels, arrows — follows. */
  ids: string[]
  axis: 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY'
}

/** Space several elements evenly along one axis. */
export interface SceneDistributeOp {
  op: 'distribute'
  /** Two or more element ids, spaced in the order their current coordinates put
   *  them in rather than the order they are written here — the caller is describing
   *  a row, not re-ordering one. */
  ids: string[]
  axis: 'x' | 'y'
  /** Fixed spacing between neighbours, in pixels. Omitted, the existing gaps are
   *  equalized within the span the elements already cover and the outermost two do
   *  not move — which needs at least three of them to mean anything. */
  gap?: number
}

export type SceneOp =
  | SceneAddOp
  | SceneUpdateOp
  | SceneDeleteOp
  | SceneAlignOp
  | SceneDistributeOp

/** The union of everything the tab can be asked to do. */
export type Command =
  | { cmd: 'status' }
  | { cmd: 'list_files' }
  | { cmd: 'manifest' }
  | { cmd: 'search'; query: string; globs?: string[]; caseSensitive?: boolean; contextLines?: number; limit?: number }
  | { cmd: 'read_many'; files: ReadManyRequest[] }
  | { cmd: 'apply_patch'; workspace: string; patch: string; expected: RevisionExpectation[] }
  | { cmd: 'read'; path?: string }
  | { cmd: 'edit'; path?: string; edits: TextEdit[] }
  | { cmd: 'write'; path?: string; text: string }
  | { cmd: 'open'; path: string }
  | { cmd: 'create_file'; path: string; content?: string }
  /** A new canvas, drawn and **opened** in one command. */
  | { cmd: 'create_canvas'; path: string; ops?: SceneOp[] }
  | { cmd: 'check'; path?: string }
  | { cmd: 'scene_get'; path?: string; full?: boolean }
  | { cmd: 'scene_edit'; path?: string; ops: SceneOp[]; expectedRevision?: number | 'absent' }
  /** A picture of a canvas, for the agent that drew it. */
  | { cmd: 'scene_render'; path?: string; ids?: string[] }

export type CommandName = Command['cmd']

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/** Mirrors `FileKind` in `lib/tree.ts`, spelled out here so the protocol module
 *  keeps its no-imports rule. */
export type DocKind = 'mermaid' | 'markdown' | 'excalidraw'

/**
 * The palette the app is rendering with, which the agent has to know about because it is **not in
 * the document**.
 */
export interface StateTheme {
  /** The preset's id (`'tokyo-night'`), `'custom'` for a hand-tuned palette, or
   *  null when no theme is set and mermaid's own default look applies. */
  name: string | null
  mode: 'light' | 'dark'
}

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
  /** Never omitted, like `repo` and `openPath`: the TypeScript declares it
   *  required, so an absent key would arrive as undefined. */
  theme: StateTheme
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

/** Which document a command actually acted on, and whether it had to invent it. */
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
  kind: DocKind
  revision: number
  /**
   * True when what came back is byte-for-byte (drawing-for-drawing, for a scene) what the branch
   * has committed.
   */
  committed: boolean
}

export interface WorkspaceFile {
  path: string
  kind: DocKind
  size: number
  revision: number
  dirty: boolean
  created: boolean
}

export interface WorkspaceManifestResult {
  workspace: string
  identity: { mode: 'local' } | { mode: 'github'; owner: string; repo: string; branch: string }
  activePath: string | null
  files: WorkspaceFile[]
  truncated: boolean
}

export interface SearchResult {
  matches: Array<{ path: string; line: number; excerpt: string; revision: number }>
  scannedBytes: number
  truncated: boolean
}

export interface ReadManyItem {
  path: string
  ok: boolean
  text?: string
  kind?: DocKind
  revision?: number
  committed?: boolean
  startLine?: number
  endLine?: number
  lineCount?: number
  error?: string
}

export interface ReadManyResult {
  files: ReadManyItem[]
  truncated: boolean
}

export interface PatchConflict {
  path: string
  expected: ExpectedRevision
  revision: number | 'absent'
  excerpt: string
  message: string
}

export interface PatchResult {
  applied: boolean
  files: Array<{
    path: string
    revision: number
    created: boolean
    added: number
    deleted: number
    diagnostics: Diagnostic[]
  }>
  conflicts: PatchConflict[]
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
  /** The element's own colors, so an addition can match what is already on the canvas. */
  strokeColor: string | null
  backgroundColor: string | null
}

/** What kind of layout defect a `SceneWarning` reports. Named rather than free
 *  text so a caller can act on the kind and read the message for the numbers. */
export type SceneWarningKind =
  /** A bound label is bigger than the shape holding it, so the text runs outside. */
  | 'label_overflow'
  /** Two shapes are drawn over each other. */
  | 'overlap'
  /** A standalone text element sits inside a shape without being bound to it. */
  | 'text_not_bound'
  /** An arrow passes through a shape that is not one of its endpoints. */
  | 'arrow_crosses'
  /** Several arrows join the same pair of shapes, so they are drawn on top of each
   *  other. */
  | 'arrow_duplicate'
  /** An arrow ends beside a shape without attaching to it, so moving the shape
   *  leaves it behind. */
  | 'arrow_unbound'
  /** Two edges are close to lining up without doing so. */
  | 'misaligned'
  /** Excalidraw's own fonts were not loaded when the labels were measured, so every
   *  box sized in this call may be narrower than the text it holds. Not a defect in
   *  the drawing — a defect in the measurement, reported because the caller can act
   *  on it (re-run the edit against an open canvas) and cannot otherwise see it. */
  | 'font_unavailable'

/** One layout problem found in a scene, for the agent that drew it. */
export interface SceneWarning {
  kind: SceneWarningKind
  /** Plain prose, naming the elements and the numbers to change. This is the field
   *  the agent acts on; `kind` is for grouping. */
  message: string
  /** The elements the finding is about, so a follow-up `update` op has its ids
   *  without another `scene_get`. */
  ids: string[]
}

export interface SceneGetResult {
  path: string | null
  revision: number
  elementCount: number
  elements: SceneElementSummary[]
  /**
   * Layout problems in the scene. **Always present, empty when there are none** — and that is the
   * whole reason this needed no `PROTOCOL_VERSION` bump.
   */
  warnings: SceneWarning[]
  /** Only when `full` was requested — the entire scene file. Large. */
  json?: string
}

/**
 * A rendered canvas. The image is bounded rather than sized: `SCENE_RENDER_LONG_EDGE` is a ceiling
 * the drawing is scaled *down* to when it exceeds it, never up.
 */
export interface SceneRenderResult {
  path: string | null
  /** Elements in the whole scene, as `scene_get` counts them, whether or not the
   *  render was cropped to some of them. */
  elementCount: number
  /** How many elements the picture actually contains. Larger than the `ids` asked
   *  for when a crop pulled in labels and connecting arrows, and equal to
   *  `elementCount` for a whole-canvas render. */
  rendered: number
  /** `image/webp`, or `image/png` where the browser cannot encode webp. */
  mimeType: string
  /** Pixel size of the image, which is *not* the size of the drawing — see
   *  `SCENE_RENDER_LONG_EDGE`. Reported so the agent can tell a render that hit the
   *  cap from one that did not. */
  width: number
  height: number
  /** What the drawing was multiplied by to fit. Below 1 means the picture was
   *  downscaled, and **anything the agent cannot make out is explained by this
   *  number** — the fix is a cropped render, not a complaint about the encoder. */
  scale: number
  dataBase64: string
  /** The same findings `scene_get` returns, on the same always-present rule. A
   *  picture and a list of what is wrong with it answer different questions, and an
   *  agent that has just been handed the picture is exactly who wants both. */
  warnings: SceneWarning[]
}

export interface SceneEditResult extends Touched {
  applied: number
  revision: number
  elementCount: number
  /** Layout problems in the scene *after* the edit — including ones the edit did not
   *  cause, because the caller is the only party that can fix any of them and the
   *  distinction is not worth a second tool call. Same always-present rule as
   *  `SceneGetResult.warnings`. */
  warnings: SceneWarning[]
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
  /**
   * An agent has deliberately attached to this tab (`ideate_connect`), and only now can it read or
   * change the document.
   */
  | { t: 'attached'; agent: string | null }
  /** The agent let go — it called `ideate_disconnect`, or its attachment idled out.
   *  The socket stays up and the tab keeps holding its bucket. */
  | { t: 'detached' }
  | { t: 'req'; id: number; command: Command }

export type ClientFrame =
  /** First frame, inside `HELLO_DEADLINE_MS`. The code is the credential; it travels
   *  in-band because a browser WebSocket cannot set request headers. */
  | { t: 'hello'; code: string; protocol: number }
  | { t: 'res'; id: number; ok: true; data: unknown; metrics: { browserMs: number } }
  | { t: 'res'; id: number; ok: false; message: string; metrics: { browserMs: number } }
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
/**
 * The service is at `MAX_WS_SESSIONS`. Delivered on an *accepted* socket rather than as a refused
 * handshake, because a refused handshake reaches a browser as an anonymous 1006 — see
 * `CAPACITY_PATH`.
 */
export const CLOSE_SERVICE_FULL = 4005
