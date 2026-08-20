'use client'

import { useEffect, useRef, useState } from 'react'
import {
  CLOSE_PROTOCOL_MISMATCH,
  CLOSE_SLOT_TAKEN,
  CLOSE_UNAUTHORIZED,
  BRIDGE_PORTS,
  PROTOCOL_VERSION,
  TOKEN_ENDPOINT,
  type BridgeState,
  type Command,
  type Diagnostic,
  type EditResult,
  type ListFilesResult,
  type ReadResult,
  type SceneEditResult,
  type SceneGetResult,
  type SceneOp,
  type ServerFrame,
  type StatusResult,
  type TextEdit,
} from './agentProtocol'
import { useDebouncedValue } from './hooks'

/**
 * The tab's half of Agent Link.
 *
 * "Agent Link" is the feature as the user meets it; "bridge" below is the
 * transport it runs over — the loopback WebSocket in `mcp/bridge.ts`.
 *
 * **The tab is the client.** A web page cannot open a listening socket, so the MCP
 * server on the user's machine hosts the WebSocket and this dials out to it. One
 * consequence shapes everything below: the socket belongs to the *agent's*
 * process, which starts and stops with an agent session, while this tab stays open
 * for days. So "enabled" means *keep trying to connect*, and disconnection is the
 * normal case rather than an error.
 *
 * `127.0.0.1` is used literally rather than `localhost`. A loopback IP literal is
 * a potentially-trustworthy origin and so exempt from mixed-content blocking,
 * which is what lets a page served over https reach a `ws://` bridge at all; the
 * hostname does not get that exemption.
 */

export type AgentLinkStatus =
  /** The toggle is off. */
  | 'off'
  /** Trying — including the long stretches when no agent is running. */
  | 'connecting'
  /** The socket is up and this tab holds the bridge, but no agent has claimed it.
   *  Distinct from `attached` on purpose: an MCP server starts with an agent
   *  session, so a live socket is not evidence that anybody decided to drive this
   *  document. Reporting it as connected would make the toolbar lie. */
  | 'linked'
  /** An agent called `ideate_connect`. Only now can it read or edit. */
  | 'attached'
  /** Refused in a way that retrying cannot fix. */
  | 'blocked'

export interface AgentLinkCapabilities {
  /** The same snapshot that gets pushed as a `state` event, read on demand so a
   *  `status` call answers with the truth rather than the last debounced push. */
  state: () => BridgeState
  listFiles: () => ListFilesResult
  readOpen: () => ReadResult
  readPath: (path: string) => Promise<ReadResult>
  /** Returns the resulting document. The command handler needs it synchronously
   *  to report diagnostics on what was just written — `setText` only reaches React
   *  on the next render, so anything read back from state here would describe the
   *  document as it was *before* the edit. */
  applyEdits: (edits: readonly TextEdit[]) => Promise<string>
  writeText: (text: string) => void
  openFile: (path: string) => Promise<void>
  createFile: (path: string, content: string | undefined) => void
  /** Diagnostics for `text`, or for the open document when omitted. */
  check: (text?: string) => Promise<Diagnostic[]>
  sceneGet: (full: boolean) => SceneGetResult
  sceneEdit: (ops: readonly SceneOp[]) => Promise<SceneEditResult>
  cursor: () => { line: number; column: number } | null
}

export interface UseAgentLinkOptions {
  enabled: boolean
  /** Recomputed every render; pushed to the MCP when it changes so `ideate_status`
   *  needs no round trip and a text tool aimed at a scene can be refused early. */
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
}

const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000

export function useAgentLink({ enabled, state, caps }: UseAgentLinkOptions): AgentLink {
  const [status, setStatus] = useState<AgentLinkStatus>('off')
  const [detail, setDetail] = useState<string | null>(null)
  const [agent, setAgent] = useState<string | null>(null)

  // Handlers are read through a ref, updated on every render. Putting `caps` in
  // the effect's dependencies instead would tear the socket down and rebuild it
  // on every keystroke, since the capability closures capture editor state.
  const capsRef = useRef(caps)
  capsRef.current = caps

  // The socket, once authenticated. Null while connecting — commands and state
  // pushes must not go out before the MCP has accepted the token, or a refused
  // connection would look like a working one.
  const liveRef = useRef<WebSocket | null>(null)
  const [liveTick, setLiveTick] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setStatus('off')
      setDetail(null)
      setAgent(null)
      return
    }

    let cancelled = false
    let socket: WebSocket | null = null
    let retry: number | undefined
    let backoff = BACKOFF_MIN_MS
    // Which port the next attempt dials. Advanced on every failure so the range is
    // walked one port per attempt rather than scanned all at once: the ordinary
    // case connects on 7391 and never touches the rest, and a page that probes a
    // whole range in one go is what Chrome's Local Network Access work exists to
    // discourage.
    let portIndex = 0

    const schedule = () => {
      if (cancelled) return
      portIndex = (portIndex + 1) % BRIDGE_PORTS.length
      // Back off only after a full pass, so a bridge sitting on 7393 is found in
      // the first second rather than after three doublings.
      if (portIndex === 0) backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      retry = window.setTimeout(connect, portIndex === 0 ? backoff : 0)
    }

    const connect = async () => {
      if (cancelled) return
      setStatus('connecting')

      // Minted fresh on every attempt. The token lives ~60s, so one held across a
      // backoff wait would be expired by the time it was presented — and a
      // short-lived, per-connection token is the point: there is nothing durable
      // in this tab for anything to steal.
      let token: string
      try {
        const response = await fetch(TOKEN_ENDPOINT, {
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error ?? `Token endpoint returned ${response.status}.`)
        }
        token = ((await response.json()) as { token: string }).token
      } catch (error) {
        setDetail(describe(error, 'Could not get a connection token from the server.'))
        schedule()
        return
      }
      if (cancelled) return

      const port = BRIDGE_PORTS[portIndex] ?? BRIDGE_PORTS[0]!
      let ws: WebSocket
      try {
        ws = new WebSocket(`ws://127.0.0.1:${port}`)
      } catch (error) {
        // A blocked or malformed URL throws synchronously rather than firing
        // `onerror`, so this path is reachable and would otherwise stall the loop.
        setDetail(describe(error, 'Could not open the bridge socket.'))
        schedule()
        return
      }
      socket = ws

      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'auth', token, protocol: PROTOCOL_VERSION }))
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
          // Stay on the port that answered, so a reconnect after an agent restart
          // does not walk the range again.
          portIndex = BRIDGE_PORTS.indexOf(port)
          liveRef.current = ws
          setLiveTick((n) => n + 1)
          // Linked, not attached: the server is holding this tab, and nothing can
          // read or edit until an agent deliberately claims it.
          setStatus('linked')
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
          setStatus('linked')
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
          setDetail(event.reason || 'The MCP server speaks a different bridge protocol version.')
          return
        }
        if (event.code === CLOSE_UNAUTHORIZED) {
          setDetail(event.reason || 'The MCP server rejected this tab’s connection token.')
        } else if (event.code === CLOSE_SLOT_TAKEN) {
          setDetail(event.reason || 'Another tab already holds the bridge.')
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

    void connect()

    return () => {
      cancelled = true
      window.clearTimeout(retry)
      liveRef.current = null
      // Close *without* a code so the MCP treats it as an ordinary disconnect and
      // frees its single-tab slot immediately.
      socket?.close()
    }
  }, [enabled])

  // Push state when it changes. Debounced: `lineCount`/`charCount` move on every
  // keystroke, and the MCP only needs to be roughly current — it re-reads the
  // document for anything it acts on.
  const stateJson = JSON.stringify(state)
  const debouncedJson = useDebouncedValue(stateJson, 300, state.openPath)
  const sentRef = useRef<string | null>(null)
  useEffect(() => {
    const ws = liveRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Forget what was sent: the next connection is a fresh MCP process that has
      // never seen this tab's state.
      sentRef.current = null
      return
    }
    if (sentRef.current === debouncedJson) return
    sentRef.current = debouncedJson
    ws.send(`{"t":"event","name":"state","state":${debouncedJson}}`)
  }, [debouncedJson, liveTick])

  return { status, detail, agent }
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
      const result: StatusResult = {
        ...state,
        cursor: caps.cursor(),
        fileCount: state.repo === null ? null : caps.listFiles().paths.length,
        protocol: PROTOCOL_VERSION,
      }
      return result
    }
    case 'list_files':
      return caps.listFiles()
    case 'read':
      return command.path === undefined ? caps.readOpen() : await caps.readPath(command.path)
    case 'edit': {
      // Diagnostics are run against the text the edit *produced*, not against
      // whatever the tab's React state happens to hold — those are the same thing
      // only after a re-render, and this runs before one.
      const next = await caps.applyEdits(command.edits)
      const result: EditResult = {
        applied: command.edits.length,
        lineCount: next === '' ? 0 : next.split('\n').length,
        diagnostics: await caps.check(next),
      }
      return result
    }
    case 'write': {
      caps.writeText(command.text)
      const result: EditResult = {
        applied: 1,
        lineCount: command.text === '' ? 0 : command.text.split('\n').length,
        diagnostics: await caps.check(command.text),
      }
      return result
    }
    case 'open':
      await caps.openFile(command.path)
      return {}
    case 'create_file':
      caps.createFile(command.path, command.content)
      return {}
    case 'check':
      return { diagnostics: await caps.check() }
    case 'scene_get':
      return caps.sceneGet(command.full === true)
    case 'scene_edit':
      return await caps.sceneEdit(command.ops)
  }
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}
