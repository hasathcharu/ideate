import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  AUTH_DEADLINE_MS,
  CLOSE_PROTOCOL_MISMATCH,
  CLOSE_SLOT_TAKEN,
  CLOSE_UNAUTHORIZED,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  type BridgeState,
  type ClientFrame,
  type Command,
} from '../lib/agentProtocol.js'
import { verifyConnectionToken } from './verify.js'

/**
 * The loopback WebSocket the browser tab connects to.
 *
 * This process listens and the tab dials out, because a web page cannot open a
 * listening socket. Everything awkward about the lifecycle follows from that: this
 * server lives and dies with the agent session, while the tab outlives many of
 * them, so "no tab connected" is an ordinary state rather than a failure.
 *
 * Security lives in two places, and the second one carries the weight:
 *
 *  1. An `Origin` allowlist on the handshake. WebSockets have no same-origin
 *     policy, so without this any page in the user's browser could claim this
 *     socket, answer the agent's commands, and feed it poisoned content. Browsers
 *     are required to send `Origin` and page JS cannot forge it, so the check is
 *     real *against a browser* — an absent header means a non-browser client and
 *     is refused outright.
 *  2. A signed, single-use connection token (`./verify`). This is what a local
 *     process spoofing `Origin` cannot produce.
 *
 * Bound to loopback only, never `0.0.0.0`.
 *
 * **Holding a tab is not the same as driving it.** An authenticated tab is parked as
 * *waiting*; nothing can read or change the document until an agent calls
 * `ideate_connect`. That separation exists because this process starts with an agent
 * session rather than by anyone's decision — adopting whichever tab happened to be
 * waiting would let an agent begin editing a human's open document with nobody
 * having chosen it. The app-side switch is one half of the handshake; this is the
 * other.
 *
 * NOTHING here may write to stdout: that is the MCP stdio channel, and a stray
 * line corrupts the protocol. All diagnostics go to stderr.
 */

export interface BridgeOptions {
  port: number
  /** Origins allowed in addition to the built-in localhost/deployment set. */
  extraOrigins: readonly string[]
  /** Trusted token issuers, pinned. */
  issuers: readonly string[]
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class Bridge {
  private readonly options: BridgeOptions
  private http: Server | null = null
  private wss: WebSocketServer | null = null

  /** The one authenticated tab. Single-slot on purpose: "newest wins" would let
   *  anything that got through silently displace the real editor. */
  private tab: WebSocket | null = null
  private lastState: BridgeState | null = null

  /** Whether an agent has deliberately claimed the waiting tab. Separate from
   *  `tab !== null`: a socket being up is not a decision. */
  private attachedAs: string | null = null
  private isAttached = false

  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  constructor(options: BridgeOptions) {
    this.options = options
  }

  /** Bind, or reject with a message naming the port. A second agent session finds
   *  the port taken, and failing loudly beats appearing to work. */
  start(): Promise<number> {
    const http = createServer((_request, response) => {
      // Nothing here serves HTTP. Answering rather than hanging makes a
      // misdirected browser tab obvious.
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end('This is the Ideate Agent Link bridge. It speaks WebSocket only.\n')
    })
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

    http.on('upgrade', (request, socket, head) => {
      const origin = request.headers.origin
      if (!origin) {
        // Every browser sends one, so its absence means a non-browser client.
        this.refuse(socket, 'Missing Origin header.')
        return
      }
      if (!this.originAllowed(origin)) {
        this.refuse(socket, `Origin not allowed: ${origin}`)
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => this.onConnection(ws, origin))
    })

    this.http = http
    this.wss = wss

    return new Promise<number>((resolve, reject) => {
      http.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          // Not fatal on its own: the caller walks the shared port range, and the
          // tab walks the same range looking for whoever answered.
          reject(new Error(`Port ${this.options.port} is already in use.`))
          return
        }
        reject(error)
      })
      http.listen(this.options.port, '127.0.0.1', () => resolve(this.options.port))
    })
  }

  close(): void {
    this.detach()
    this.rejectAllPending('The bridge is shutting down.')
    this.tab?.close()
    this.tab = null
    this.wss?.close()
    this.http?.close()
  }

  /** The tab's last reported state, or null if none has connected. Readable while
   *  merely waiting: it is metadata about which document is open, which is exactly
   *  what an agent needs in order to say what it is about to attach to. Document
   *  *content* stays behind `attach()`. */
  state(): BridgeState | null {
    return this.tab ? this.lastState : null
  }

  /** A tab is authenticated and holding the bridge. */
  waiting(): boolean {
    return this.tab !== null
  }

  attached(): boolean {
    return this.isAttached
  }

  /**
   * Claim the waiting tab. Refuses rather than blocking when none is there — the
   * agent should tell the user to switch Agent Link on, not sit in a timeout.
   */
  attach(agent: string | null): BridgeState | null {
    const tab = this.tab
    if (!tab) {
      throw new Error(
        'No Ideate tab is waiting. Open the Ideate editor in a browser and click ' +
          '"Connect Agent" in the toolbar to switch on Agent Link, then try again. ' +
          'It finds this server on its own — there is no port to configure.',
      )
    }
    if (this.isAttached) {
      // Idempotent rather than an error: a re-attach is what an agent does after
      // losing track of its own state, and failing it teaches nothing.
      return this.lastState
    }
    this.isAttached = true
    this.attachedAs = agent
    tab.send(JSON.stringify({ t: 'attached', agent }))
    this.log(`attached${agent ? ` as ${agent}` : ''}`)
    return this.lastState
  }

  /** Let go without dropping the socket, so the tab stays linked and a later
   *  `attach` needs no reconnect. */
  detach(): void {
    if (!this.isAttached) return
    this.isAttached = false
    this.attachedAs = null
    this.rejectAllPending('The agent detached.')
    if (this.tab?.readyState === this.tab?.OPEN) {
      this.tab?.send(JSON.stringify({ t: 'detached' }))
    }
    this.log('detached')
  }

  /** Send one command and wait for its answer. */
  call(command: Command): Promise<unknown> {
    const tab = this.tab
    if (!tab) {
      return Promise.reject(
        new Error(
          'No Ideate tab is connected. Open the Ideate editor in a browser and click ' +
            '"Connect Agent" in the toolbar to switch on Agent Link. It finds this ' +
            'server on its own — there is no port to configure.',
        ),
      )
    }
    if (!this.isAttached) {
      return Promise.reject(
        new Error(
          'Not attached to the Ideate tab. Call ideate_connect first — reading or ' +
            'editing someone’s open document is a deliberate step, not something that ' +
            'happens because this server started.',
        ),
      )
    }

    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `The tab did not answer "${command.cmd}" within ${REQUEST_TIMEOUT_MS / 1000}s. ` +
              'It may be busy or the page may have been reloaded.',
          ),
        )
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      tab.send(JSON.stringify({ t: 'req', id, command }))
    })
  }

  /* ---------------------------------------------------------------- */

  private originAllowed(origin: string): boolean {
    if (this.options.extraOrigins.includes(origin)) return true
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      return false
    }
    // The deployment origins are the same set as the pinned token issuers, so the
    // two controls cannot drift apart.
    if (this.options.issuers.includes(origin)) return true
    // Any localhost port: a dev server moves around (3000, 3001 when 3000 is
    // taken), and every one of them is the user's own machine.
    return (
      url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    )
  }

  /** A real 403, so a misconfiguration is diagnosable instead of a silent hang. */
  private refuse(socket: Duplex, reason: string): void {
    this.log(`refused handshake: ${reason}`)
    socket.write(
      `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${
        Buffer.byteLength(reason) + 1
      }\r\nConnection: close\r\n\r\n${reason}\n`,
    )
    socket.destroy()
  }

  private onConnection(ws: WebSocket, origin: string): void {
    // The browser WebSocket API cannot set request headers, so the token travels
    // in-band as the first frame. Anything that does not authenticate in time is
    // dropped rather than left holding a socket.
    let authenticated = false
    const deadline = setTimeout(() => {
      if (!authenticated) ws.close(CLOSE_UNAUTHORIZED, 'No auth frame.')
    }, AUTH_DEADLINE_MS)

    ws.on('message', (raw) => {
      let frame: ClientFrame
      try {
        frame = JSON.parse(String(raw)) as ClientFrame
      } catch {
        return
      }

      if (!authenticated) {
        if (frame.t !== 'auth') return
        void this.authenticate(ws, frame, origin).then((ok) => {
          if (!ok) return
          authenticated = true
          clearTimeout(deadline)
        })
        return
      }

      if (frame.t === 'event' && frame.name === 'state') {
        this.lastState = frame.state
        return
      }
      if (frame.t === 'res') this.settle(frame)
    })

    ws.on('close', () => {
      clearTimeout(deadline)
      if (this.tab !== ws) return
      this.tab = null
      this.lastState = null
      // A new tab must be attached to again on purpose; inheriting the previous
      // tab's attachment would reintroduce exactly the silent adoption this
      // separation exists to prevent.
      this.isAttached = false
      this.attachedAs = null
      this.log('tab disconnected')
      // Anything in flight will never be answered; say so rather than let each
      // call burn its whole timeout.
      this.rejectAllPending('The tab disconnected before answering.')
    })

    ws.on('error', (error) => this.log(`socket error: ${error.message}`))
  }

  private async authenticate(
    ws: WebSocket,
    frame: Extract<ClientFrame, { t: 'auth' }>,
    origin: string,
  ): Promise<boolean> {
    if (frame.protocol !== PROTOCOL_VERSION) {
      // Retrying cannot fix a version mismatch, and the tab stops trying on this
      // code — so the message has to be enough to act on.
      ws.close(
        CLOSE_PROTOCOL_MISMATCH,
        `Bridge protocol ${frame.protocol} vs ${PROTOCOL_VERSION}. Update whichever side is older.`,
      )
      return false
    }

    try {
      await verifyConnectionToken(frame.token, this.options.issuers)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Token rejected.'
      this.log(`rejected token from ${origin}: ${reason}`)
      // Close reasons are capped at 123 bytes by the protocol; a longer one throws
      // instead of closing, which would leave the socket open.
      ws.close(CLOSE_UNAUTHORIZED, truncateReason(reason))
      return false
    }

    // Claimed only after verification, so an unauthenticated connection learns
    // nothing about whether a tab is already attached.
    if (this.tab && this.tab.readyState === this.tab.OPEN) {
      ws.close(CLOSE_SLOT_TAKEN, 'Another Ideate tab already holds this bridge.')
      return false
    }

    this.tab = ws
    ws.send(JSON.stringify({ t: 'ready' }))
    this.log(`tab connected from ${origin}`)
    return true
  }

  private settle(frame: Extract<ClientFrame, { t: 'res' }>): void {
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    clearTimeout(pending.timer)
    if (frame.ok) pending.resolve(frame.data)
    else pending.reject(new Error(frame.message))
  }

  private rejectAllPending(message: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.pending.clear()
  }

  private log(message: string): void {
    // stderr, never stdout — see the module comment.
    process.stderr.write(`[ideate-mcp] ${message}\n`)
  }
}

/** WebSocket close reasons are limited to 123 UTF-8 bytes. */
function truncateReason(reason: string): string {
  const bytes = Buffer.from(reason, 'utf8')
  if (bytes.length <= 123) return reason
  return `${bytes.subarray(0, 119).toString('utf8')}…`
}
