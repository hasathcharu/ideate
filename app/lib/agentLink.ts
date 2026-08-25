'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CLOSE_PROTOCOL_MISMATCH,
  CLOSE_SERVICE_FULL,
  CLOSE_SLOT_TAKEN,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PROTOCOL_VERSION,
  type BridgeState,
  type CheckResult,
  type Command,
  type EditResult,
  type ListFilesResult,
  type ReadResult,
  type SceneEditResult,
  type SceneGetResult,
  type SceneOp,
  type SceneRenderResult,
  type ServerFrame,
  type StatusResult,
  type TextEdit,
  type Touched,
} from './agentProtocol'
import { mcpTabUrl } from './mcpOrigin'
import { loadPairingCode, savePairingCode } from './storage'
import { useDebouncedValue } from './hooks'

/**
 * The tab's half of Agent Link.
 *
 * "Agent Link" is the feature as the user meets it; the *service* below is the
 * transport it runs over — a remote Go service that is both the MCP server the
 * agent talks to and the socket this dials.
 *
 * **The tab is still the WebSocket client, but it no longer dials loopback.** Until
 * protocol 3 the MCP server ran on the user's own machine and listened on
 * `ws://127.0.0.1`, because a web page cannot open a listening socket. That worked
 * until it met Safari, which grants no loopback exemption for mixed content and so
 * blocks the connection outright from an https page — and it confined the whole
 * feature to an agent sitting on the same machine as the browser. Dialling a remote
 * service instead costs the ability to work offline and gains every other agent:
 * containers, Codespaces, SSH boxes, browser-based ones.
 *
 * What joins the two halves is a **pairing code this tab generates**. The service
 * issues nothing and merely buckets by the code's hash, which is why there is no
 * token endpoint any more and nothing here to steal: a hostile page can generate
 * its own code, and pair with itself.
 *
 * One consequence of the inversion survives it: the socket belongs to a service
 * that can restart, and to a tab that stays open for days. So "enabled" still means
 * *keep trying to connect*, and a dropped connection is an ordinary state rather
 * than an error.
 */

export type AgentLinkStatus =
  /** The toggle is off. */
  | 'off'
  /** Trying — including the stretches when the service is restarting. */
  | 'connecting'
  /** The socket is up and this tab holds its pairing code's bucket, but no agent
   *  has claimed it. Distinct from `attached` on purpose: pairing answers *which*
   *  tab, and the human answered it by switching this on. Whether to drive it is
   *  the agent's separate decision, and reporting a live socket as connected would
   *  make the toolbar claim someone can edit the document when nobody can. */
  | 'paired'
  /** An agent called `ideate_connect`. Only now can it read or edit. */
  | 'attached'
  /** Refused in a way that retrying cannot fix. */
  | 'blocked'
  /** The service is at capacity.
   *
   *  Its own state rather than a flavour of `blocked`, because the two want
   *  opposite behaviour: `blocked` means retrying is pointless, and capacity does
   *  free up, so retrying is not. But hammering a full service is not how to wait
   *  for it either — so the automatic loop stops and waits for an explicit Retry,
   *  which has the side benefit of holding the message still long enough to read. */
  | 'full'

/** What an `applyEdits` produced, plus which document it landed on.
 *
 *  The text is here rather than read back from state because the command handler
 *  needs it *synchronously* to diagnose what was just written — `setText` only
 *  reaches React on the next render, so state would describe the document as it was
 *  before the edit. */
export interface AppliedEdit extends Touched {
  text: string
}

/**
 * Everything the hook needs from the app to serve a command.
 *
 * Every document capability takes an optional `path`, mirroring `Command`:
 * `undefined` is the open document, a string is a file in the workspace whether or
 * not anybody has opened it. Enforcing that a *mutation* names one is the app's job
 * and not this module's — only the app knows which document is open, and the
 * untitled one has no path to name.
 */
export interface AgentLinkCapabilities {
  /** The same snapshot that gets pushed as a `state` event, read on demand so a
   *  `status` call answers with the truth rather than the last debounced push. */
  state: () => BridgeState
  listFiles: () => ListFilesResult
  read: (path?: string) => Promise<ReadResult>
  applyEdits: (edits: readonly TextEdit[], path?: string) => Promise<AppliedEdit>
  writeText: (text: string, path?: string) => Promise<Touched>
  openFile: (path: string) => Promise<void>
  /** Create a `.mmd`/`.md` file and open it. A `.excalidraw` path is refused —
   *  `createCanvas` is the door for one, because an empty canvas is no use. */
  createFile: (path: string, content: string | undefined) => void
  /** Create a `.excalidraw` file, draw `ops` into it and open it. Async where
   *  `createFile` is not, because the ops go through `applySceneOps` — which waits
   *  on the fonts before it measures a single label. */
  createCanvas: (path: string, ops: readonly SceneOp[]) => Promise<SceneEditResult>
  /** Diagnostics for `text` when given — the text an edit just produced, which is
   *  not yet anywhere else — else for the document `path` names, else for the open
   *  one. `path` also decides which *kind* the text is diagnosed as. */
  check: (target: { text?: string; path?: string }) => Promise<CheckResult>
  sceneGet: (full: boolean, path?: string) => Promise<SceneGetResult>
  sceneEdit: (ops: readonly SceneOp[], path?: string) => Promise<SceneEditResult>
  /** A small picture of a canvas. Read-only, so it takes the same optional `path`
   *  as `sceneGet` and leaves the editor where it is. */
  sceneRender: (path?: string) => Promise<SceneRenderResult>
  cursor: () => { line: number; column: number } | null
}

export interface UseAgentLinkOptions {
  enabled: boolean
  /** Origin of the Agent Link service, already resolved (config override, else
   *  `DEFAULT_MCP_ORIGIN`). Changing it reconnects. */
  mcpOrigin: string
  /** Recomputed every render; pushed to the service when it changes so
   *  `ideate_status` needs no round trip and a text tool aimed at a scene can be
   *  refused early. */
  state: BridgeState
  caps: AgentLinkCapabilities
}

export interface AgentLink {
  status: AgentLinkStatus
  /** Why, when the status is worth explaining. Rendered in the modal. */
  detail: string | null
  /** What the attached agent called itself, when it said. Shown to the human so
   *  the connection is not anonymous. */
  agent: string | null
  /** This tab's pairing code, grouped for reading aloud (`XXXX-XXXX`). Empty for
   *  the first render, before `sessionStorage` has been consulted. */
  code: string
  /** Mint a new code. The old one stops working immediately, which is the point:
   *  it is how you revoke an agent's access without switching the feature off. */
  regenerate: () => void
  /** Try again after a refusal that stopped the automatic loop. */
  retry: () => void
}

const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000

/**
 * The fraction of the backoff a retry is *not* allowed to fire before.
 *
 * A restart drops every tab at the same instant, so an undithered backoff has them
 * all return in lockstep — and behind one public address (an office, a campus)
 * that arrives at the service as one spike per round, against a per-IP limiter
 * that answers 429. A refused handshake reaches the tab as an anonymous 1006,
 * indistinguishable from the service being down, so the failure that lockstep
 * produces is also the one nobody can diagnose. Spreading each round over most of
 * its window is what stops the tabs from being synchronized at all.
 *
 * The floor keeps the spread from including "immediately", which would have the
 * first retry land while the service is still coming back up.
 */
const BACKOFF_JITTER_FLOOR = 0.25

/**
 * A fresh pairing code.
 *
 * `b % 32` is exactly uniform rather than approximately so: the alphabet is 32
 * characters and a byte has 256 values, so every character is reachable by the same
 * number of byte values. The usual modulo-bias caveat does not apply, and it is
 * worth saying because the next person to widen the alphabet will reintroduce it.
 */
function generateCode(): string {
  const bytes = new Uint8Array(PAIRING_CODE_LENGTH)
  crypto.getRandomValues(bytes)
  let code = ''
  for (const byte of bytes) code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]
  return code
}

/** `XXXX-XXXX`. The service strips the separator and folds case, so the human can
 *  read this out however they like and their agent can type it however it likes. */
function group(code: string): string {
  if (code.length !== PAIRING_CODE_LENGTH) return code
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export function useAgentLink({
  enabled,
  mcpOrigin,
  state,
  caps,
}: UseAgentLinkOptions): AgentLink {
  const [status, setStatus] = useState<AgentLinkStatus>('off')
  const [detail, setDetail] = useState<string | null>(null)
  const [agent, setAgent] = useState<string | null>(null)

  // Empty until the mount effect below has run: `sessionStorage` and
  // `crypto.getRandomValues` are both browser-only, and generating during render
  // would hand the server and the client different codes.
  const [code, setCode] = useState('')
  useEffect(() => {
    const existing = loadPairingCode()
    if (existing) {
      setCode(existing)
      return
    }
    const minted = generateCode()
    savePairingCode(minted)
    setCode(minted)
  }, [])

  const regenerate = useCallback(() => {
    const minted = generateCode()
    savePairingCode(minted)
    // The connection effect keys on `code`, so this tears down the socket holding
    // the old bucket and dials again under the new one — which is exactly what
    // "the old code stops working" has to mean.
    setCode(minted)
  }, [])

  // Bumped by `retry`, and in the dependency list purely so that re-running the
  // effect is what a retry *is*. Nothing reads its value.
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  // Handlers are read through a ref, updated on every render. Putting `caps` in
  // the effect's dependencies instead would tear the socket down and rebuild it
  // on every keystroke, since the capability closures capture editor state.
  const capsRef = useRef(caps)
  capsRef.current = caps

  // The socket, once paired. Null while connecting — commands and state pushes must
  // not go out before the service has accepted the hello, or a refused code would
  // look like a working link.
  const liveRef = useRef<WebSocket | null>(null)
  const [liveTick, setLiveTick] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setStatus('off')
      setDetail(null)
      setAgent(null)
      return
    }
    if (!code) {
      // One render, between mount and the code being read back. Reporting
      // `connecting` rather than `off` keeps the modal from flashing a switch that
      // the user has just turned on as if it were still off.
      setStatus('connecting')
      return
    }

    let cancelled = false
    let socket: WebSocket | null = null
    let retryTimer: number | undefined
    let backoff = BACKOFF_MIN_MS

    const schedule = () => {
      if (cancelled) return
      // A uniform point in [floor × backoff, backoff]; the *base* still doubles, so
      // the growth is unchanged and only the correlation between tabs is broken.
      const spread = 1 - BACKOFF_JITTER_FLOOR
      retryTimer = window.setTimeout(
        connect,
        Math.round(backoff * (BACKOFF_JITTER_FLOOR + Math.random() * spread)),
      )
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }

    const connect = () => {
      if (cancelled) return
      setStatus('connecting')

      let ws: WebSocket
      try {
        ws = new WebSocket(mcpTabUrl(mcpOrigin))
      } catch (error) {
        // A blocked or malformed URL throws synchronously rather than firing
        // `onerror`, so this path is reachable and would otherwise stall the loop.
        setDetail(describe(error, 'Could not open a socket to the Agent Link service.'))
        schedule()
        return
      }
      socket = ws

      ws.onopen = () => {
        // In-band, and it has to be: a browser WebSocket cannot set request
        // headers, so the code cannot travel in one. The service gives it two
        // seconds.
        ws.send(JSON.stringify({ t: 'hello', code, protocol: PROTOCOL_VERSION }))
      }

      ws.onmessage = (event) => {
        let frame: ServerFrame
        try {
          frame = JSON.parse(String(event.data)) as ServerFrame
        } catch {
          return
        }
        if (frame.t === 'ready') {
          backoff = BACKOFF_MIN_MS
          liveRef.current = ws
          setLiveTick((n) => n + 1)
          // Paired, not attached: this tab holds its code, and nothing can read or
          // edit until an agent deliberately claims it.
          setStatus('paired')
          setDetail(null)
          setAgent(null)
          return
        }
        if (frame.t === 'attached') {
          setStatus('attached')
          setAgent(frame.agent)
          return
        }
        if (frame.t === 'detached') {
          setStatus('paired')
          setAgent(null)
          return
        }
        if (frame.t === 'req') void respond(ws, frame.id, frame.command, capsRef.current)
      }

      ws.onclose = (event) => {
        if (liveRef.current === ws) {
          liveRef.current = null
          setLiveTick((n) => n + 1)
        }
        if (cancelled) return

        // A protocol mismatch is the one refusal retrying cannot fix — the two
        // sides were built against different versions of the wire format, and
        // reconnecting every 30s would just log the same complaint forever.
        if (event.code === CLOSE_PROTOCOL_MISMATCH) {
          setStatus('blocked')
          setDetail(event.reason || 'The Agent Link service speaks a different protocol version.')
          return
        }
        // Capacity is not permanent, but it is not something to hammer either. Stop
        // the loop and wait for the human to press Retry — or, better, to point
        // this tab at a service of their own.
        if (event.code === CLOSE_SERVICE_FULL) {
          setStatus('full')
          setDetail(event.reason || 'The shared Agent Link service is at capacity.')
          setAgent(null)
          return
        }
        if (event.code === CLOSE_SLOT_TAKEN) {
          // Reachable mainly by duplicating a tab, which copies `sessionStorage`
          // and so copies the code. Retrying is still right — the other tab may
          // close — but the detail has to name the fix, because waiting for that is
          // not much of a plan.
          setDetail(
            event.reason ||
              'Another tab is already using this pairing code. Regenerate it here to take over.',
          )
        } else if (event.reason) {
          setDetail(event.reason)
        }
        setStatus('connecting')
        setAgent(null)
        schedule()
      }

      // `onerror` carries no useful detail by design (the spec withholds it to
      // avoid leaking cross-origin information), so the close handler that always
      // follows is where the reason is read from.
      ws.onerror = () => {}
    }

    connect()

    return () => {
      cancelled = true
      window.clearTimeout(retryTimer)
      liveRef.current = null
      // Close *without* a code so the service treats it as an ordinary disconnect.
      // The bucket survives its grace window either way, so an attached agent keeps
      // its attachment across a reload.
      socket?.close()
    }
  }, [enabled, mcpOrigin, code, attempt])

  // Push state when it changes. Debounced: `lineCount`/`charCount` move on every
  // keystroke, and the service only needs to be roughly current — it re-reads the
  // document for anything it acts on.
  const stateJson = JSON.stringify(state)
  const debouncedJson = useDebouncedValue(stateJson, 300, state.openPath)
  const sentRef = useRef<string | null>(null)
  useEffect(() => {
    const ws = liveRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Forget what was sent: the next connection may be a restarted service that
      // has never seen this tab's state.
      sentRef.current = null
      return
    }
    if (sentRef.current === debouncedJson) return
    sentRef.current = debouncedJson
    ws.send(`{"t":"event","name":"state","state":${debouncedJson}}`)
  }, [debouncedJson, liveTick])

  return { status, detail, agent, code: group(code), regenerate, retry }
}

/** Run one command and answer it. Never throws: a rejected promise here would
 *  leave the MCP waiting out its full timeout for no reason. */
async function respond(
  ws: WebSocket,
  id: number,
  command: Command,
  caps: AgentLinkCapabilities,
): Promise<void> {
  let data: unknown
  try {
    data = await execute(command, caps)
  } catch (error) {
    send(ws, { t: 'res', id, ok: false, message: describe(error, 'The command failed.') })
    return
  }
  send(ws, { t: 'res', id, ok: true, data })
}

function send(ws: WebSocket, frame: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(frame))
}

async function execute(command: Command, caps: AgentLinkCapabilities): Promise<unknown> {
  switch (command.cmd) {
    case 'status': {
      // Read live rather than reusing the last pushed event: the state push is
      // debounced, and a status call is exactly when being 300ms stale is most
      // confusing.
      const state = caps.state()
      const files = caps.listFiles().paths.length
      const result: StatusResult = {
        ...state,
        cursor: caps.cursor(),
        // Not `repo === null ? null` any more: local mode has files of its own, and
        // reporting none there told an agent to stop looking.
        fileCount: state.mode === 'local' || state.repo !== null ? files : null,
        protocol: PROTOCOL_VERSION,
      }
      return result
    }
    case 'list_files':
      return caps.listFiles()
    case 'read':
      return await caps.read(command.path)
    case 'edit': {
      // Diagnostics are run against the text the edit *produced*, not against
      // whatever the tab's React state happens to hold — those are the same thing
      // only after a re-render, and this runs before one.
      const { path, created, text } = await caps.applyEdits(command.edits, command.path)
      const { diagnostics } = await caps.check({ text, path: command.path })
      const result: EditResult = {
        path,
        created,
        applied: command.edits.length,
        lineCount: lineCount(text),
        diagnostics,
      }
      return result
    }
    case 'write': {
      const { path, created } = await caps.writeText(command.text, command.path)
      const { diagnostics } = await caps.check({ text: command.text, path: command.path })
      const result: EditResult = {
        path,
        created,
        applied: 1,
        lineCount: lineCount(command.text),
        diagnostics,
      }
      return result
    }
    case 'open':
      await caps.openFile(command.path)
      return {}
    case 'create_file':
      caps.createFile(command.path, command.content)
      return {}
    case 'create_canvas':
      return await caps.createCanvas(command.path, command.ops ?? [])
    case 'check':
      return await caps.check({ path: command.path })
    case 'scene_get':
      return await caps.sceneGet(command.full === true, command.path)
    case 'scene_edit':
      return await caps.sceneEdit(command.ops, command.path)
    case 'scene_render':
      return await caps.sceneRender(command.path)
  }
}

/** Lines in a document, counting an empty one as zero rather than as one. */
function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}
