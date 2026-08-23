# Ideate Agent Link service

One Go process that is **both** the MCP server a coding agent talks to and the
relay that reaches the browser tab:

```
agent ──MCP Streamable HTTP──► this service ──WebSocket──► browser tab
```

A **pairing code** the tab generates, and the human hands to their agent, joins
the two halves.

You are probably reading this because Ideate told you the shared service is at
capacity. [Skip to running your own](#run-your-own) — one container, no
configuration, no database.

## Why it exists in this shape

Agent Link used to be a Node MCP server that ran on the user's own machine and
**listened** on `ws://127.0.0.1`, with the browser tab dialling out to it. That
had to change:

- **Safari could not use it at all.** Safari grants no loopback exemption for
  mixed content, so `ws://127.0.0.1` from an `https://` page is blocked outright.
  Chrome's Local Network Access work is heading the same way.
- **Only an agent on the same machine could reach the tab** — no containers, no
  Codespaces, no SSH boxes, no browser-based agents.
- Everything awkward in that design (a port range walked one port per reconnect,
  an `Origin` allowlist doing security work, a whole JWT/JWKS apparatus) existed
  *only* because a web page cannot open a listening socket. Inverting the socket
  deletes all of it.

The cost is honest and worth stating: **Agent Link no longer works offline.**

## What it holds, and what it does not

The service keeps the registry of live tab sockets in memory, and that is
irreducible — a socket lives in the process that accepted it, and both ends of a
pairing must be in one process to be piped together. So:

- **No datastore.** Every record describes a connection. If the process dies the
  connections die with it, so a store would be preserving rows about sockets that
  no longer exist. There is nothing durable to persist.
- **No horizontal scaling** without sharding by code. One instance is correct for
  a long time; `MAX_WS_SESSIONS` is what keeps that honest.
- **No CORS configuration anywhere.** The two callers are a browser opening a
  WebSocket (which has no same-origin policy and so no preflight) and an MCP
  client, which is not a browser. A CORS header here would answer a question
  nobody asked.

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /mcp` | MCP over Streamable HTTP. All twelve tools; every one takes a `code`. |
| `GET /v1/tab` | The browser tab's WebSocket. Sends `hello` within 2s, claims its bucket, gets `ready`. |
| `GET /v1/capacity` | `{live, max}` — **529** when full, 200 otherwise. |
| `GET /v1/stats` | How many sessions this process is handling — `{live, max, withTab, inGrace, attached}` — plus a `process` object with what that is costing the box. **Basic auth**, and absent entirely (404) unless `STATS_USER`/`STATS_PASSWORD` are set. |
| `GET /healthz` | Liveness. **Deliberately not gated on capacity:** a full service is a healthy service, and gating it would have the platform restart the instance at the exact moment the most people were using it. |

`GET /mcp` answers 405. That is what stateless mode means — every request carries
its own pairing code, so there is nothing an `Mcp-Session-Id` would identify that
the code does not already.

### Why capacity is reported twice

A *refused* WebSocket handshake cannot carry a status code to a browser: the tab
sees `onclose` 1006 with an empty reason, indistinguishable from the service being
down. So a full service **accepts** the socket and then closes it with
`4005 CLOSE_SERVICE_FULL` and a readable reason, and `/v1/capacity` is where a
client that *can* read a status code gets the 529.

### The process figures

```json
{
  "live": 3, "max": 250, "withTab": 3, "inGrace": 0, "attached": 2,
  "process": {
    "uptimeSeconds": 8140.2,
    "cpus": 2,
    "cpuSeconds": 41.9,
    "cpuPercent": 0.7,
    "rssBytes": 43859968,
    "runtimeBytes": 21430272,
    "heapBytes": 4194304,
    "goroutines": 14
  }
}
```

The counts say whether the instance is busy; these say whether it is in trouble.
Four things about them are worth knowing before you alert on any of them:

- **`cpuPercent` is percent of one CPU**, the way `top` reports it, so it can exceed
  100 on a multi-core box — divide by `cpus` for "percent of the CPU this process may
  use". It covers the last sweep interval (10s) and is advanced by the sweeper, not
  by your request, so two pollers cannot shorten each other's window. It is **absent
  for the first few seconds** of a process's life, before any window has closed.
- **The CPU number does not come from `runtime/metrics`.** Go's
  `/cpu/classes/total:cpu-seconds` counts idle `GOMAXPROCS` time as well as work, so
  it grows at roughly `GOMAXPROCS` × wall-clock no matter what the service is doing —
  measured, it read 3.6 CPU-seconds for 300ms of real work. This uses `getrusage`,
  which is the same accounting the kernel and your platform's CPU limit use.
- **`rssBytes` is what an OOM kill is measured against**, and it is read from
  `/proc/self/statm`, so it is **Linux only** and absent when running the binary on
  macOS. `runtimeBytes` — everything the Go runtime has mapped — is always present
  and is the stand-in there. The two differ legitimately: the runtime counts pages it
  has already released back to the OS.
- **`heapBytes` is the one to watch against `MAX_INFLIGHT_BYTES`**, since forwarded
  frames are what the budget bounds. See [Sizing](#sizing).

Nothing here is a Prometheus endpoint. `cpuSeconds` is cumulative and
`uptimeSeconds` is monotonic, so a scraper can derive its own rates from them, but if
you want real metrics put a real exporter in front — this route exists so that one
`curl` answers "is this instance healthy".

## Configuration

Every value has a default that is correct for a small shared deployment, so the
service starts with no environment set at all. Anything *present and wrong* is a
startup error rather than a silent fallback — a mistyped timeout quietly reverting
to 15s is the kind of thing that gets diagnosed months later.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `7391` | The old loopback bridge port, reused. It is also the only port on which the app will accept a plaintext MCP origin. |
| `PUBLIC_URL` | unset | The origin this instance is reached at. Validated with the same TLS rule the app applies to its Advanced options field, so you cannot advertise a plaintext service and find out from your users. |
| `ALLOWED_ORIGINS` | `https://ideate.haru.lk` | Comma-separated. A **soft** allowlist on the tab handshake — it stops the service being used as free infrastructure, and is *not* the security control. Any `localhost` origin is always allowed, since a dev server moves between ports. |
| `STATS_USER` | unset | Basic-auth user for `GET /v1/stats`. Set neither and the route does not exist; set one without the other and the service refuses to start, since either mistake is one an operator would make while believing the route was protected. |
| `STATS_PASSWORD` | unset | Its password. Sent by the client on every request, so the endpoint is only as private as the TLS in front of it — which rule 12 already requires. |
| `REQUEST_TIMEOUT` | `15s` | Per forwarded command. A timeout is a tool error the agent can act on, not a transport failure. |
| `TAB_GRACE` | `30s` | How long a bucket outlives its tab socket, so a reload does not cost the agent its attachment. |
| `ATTACH_IDLE_TIMEOUT` | `30m` | Expires an attachment with no tool calls. Without it, a killed agent leaves the toolbar claiming somebody can edit the document. |
| `MAX_BODY_BYTES` | `8388608` | MCP request body cap. |
| `MAX_WS_SESSIONS` | `250` | Concurrent tab buckets. |
| `MAX_INFLIGHT_BYTES` | `67108864` | Global budget for forwarded command payloads. Must be at least one frame (8MB) or the service refuses to start. |

### Sizing

Idle sockets are not the constraint. Roughly 100KB each including TLS and two
goroutines means thousands fit in 512MB, and a human-driven agent issues a command
every few seconds, so half a vCPU is nowhere near saturated. 250 is one to two
orders of magnitude above realistic load while still being a hard bound.

The real memory risk is **many large frames at once**, which is what
`MAX_INFLIGHT_BYTES` bounds: 250 × 8MB would be a 2GB spike on a 512MB box. A
command that cannot acquire budget waits, then fails with a message that says to
retry.

## Run your own

The published image is
[`hasathcharu/ideate-mcp`](https://hub.docker.com/r/hasathcharu/ideate-mcp).
It needs no configuration and writes nothing to disk:

```sh
docker run --rm -p 7391:7391 hasathcharu/ideate-mcp
```

From a checkout, either of these does the same thing:

```sh
go run ./cmd/server                                     # from this directory
docker build -t ideate-mcp . && docker run --rm -p 7391:7391 ideate-mcp
```

Then, in Ideate, **Agent Link → Advanced options → Agent Link service** →
`http://localhost:7391`, and register it with your agent once:

```sh
claude mcp add --transport http ideate http://localhost:7391/mcp
```

A stdio-only client can front it with `npx mcp-remote http://localhost:7391/mcp`.

The app accepts `https://…` anywhere, or plain `http://` **only** on
`localhost:7391` / `127.0.0.1:7391`: plaintext elsewhere would put the pairing code
and every document the tab reads on the wire in the clear. Both sides enforce that
(`app/lib/mcpOrigin.ts` and `internal/config.ValidateMCPOrigin`), so for
anything reachable from the internet, terminate TLS in front of it (Caddy, nginx,
your platform's load balancer) and set `PUBLIC_URL` and `ALLOWED_ORIGINS`.

## Security

**The pairing code is the credential, and it is the only one.** The service issues
nothing: the tab generates its own code client-side and the service buckets by
`sha256` of it. A hostile page can generate its own code and pair with itself,
which is harmless — what it cannot do is guess someone else's.

- The code is **never logged, never in a URL, never in a query string.** Log lines
  carry an 8-character prefix of the hash at most.
- Eight characters of Crockford base32 is 2^40, which only holds up if guesses are
  rationed — so there is a per-IP token bucket on `/mcp` and `/v1/tab`, and a much
  tighter per-IP counter on codes that match no tab. The general limit has to sit
  in front of the body, because the code arrives as a *tool argument* and cannot be
  read until the body has been parsed.
- The tight counter charges **the first sighting of each unknown code**, not each
  request. Guessing means presenting a *distinct* code every time and still pays
  per guess; an agent left holding a regenerated code presents the same one forever
  and pays once. Without that split the limiter did not survive NAT: a company
  shares one address, so it shares one bucket, and one colleague's stale code could
  ration everybody else's first attempt — which looks exactly like an outage.
- Client addresses come from `CF-Connecting-IP` before `X-Forwarded-For`, because
  Cloudflare (like nginx) *appends* to the latter rather than replacing it, so its
  left-most entry belongs to whoever sent the request. Behind a proxy the origin
  should also refuse connections from anywhere but that proxy's ranges; a caller who
  reaches the service directly can forge either header.
- The `Origin` allowlist is a courtesy, not a control. A browser cannot forge
  `Origin` but a local process can, and neither can guess a code.
- **No tool writes to GitHub.** There is no commit tool, and rename and delete are
  deliberately not exposed either, because in Ideate those *are* commits. An
  agent's blast radius is the uncommitted working copy: on screen, and one ⌘Z away.

The standing risk this does not change is prompt injection: an agent reads
documents out of a user's repository, and a `.md` file can contain instructions
aimed at it. That is precisely why there is no commit tool.

### Why the code is a tool argument, not a header

An `Authorization: Bearer` header is the more standard remote-MCP shape and would
keep the credential out of the model's context. But a header lives in client
config, so pointing an agent at a **different tab** would mean re-running
`claude mcp add` and tearing down the MCP connection. Switching tabs mid-session is
a hard requirement, and only an argument gives it: the human names another code and
the very next call lands on another tab.

The accepted costs are that the code appears repeatedly in agent transcripts (the
same exposure as typing it into a chat), and that the bucket cannot be resolved
until the body is parsed — which is why the per-IP limiter, rather than the code, is
what guards against a flood.

## Layout

```
cmd/server/        entry point, signal handling, the reaper ticker
internal/protocol/ the wire contract, mirrored from app/lib/agentProtocol.ts
internal/session/  pairing registry, tab sockets, command routing
internal/httpapi/  MCP mount, tab WS upgrade, capacity, stats, health, rate limiting
internal/procstat/  the process's own CPU and memory, for /v1/stats
internal/ratelimit/ per-key token bucket with an expiry sweep
internal/config/   environment loading, and the shared TLS rule
testdata/frames/   golden JSON frames — see that directory's README
```

## Tests

```sh
go vet ./... && go test -race ./...
```

The bridge's behaviour is not reachable by typechecking — two real bugs in the
previous implementation were found only by driving it, and two more in this one
were found by these tests (the SDK's own 4MiB body limit silently overriding
`MAX_BODY_BYTES`, and a close code that could never reach the tab because
cancelling a read tears the socket down first). `internal/httpapi` runs a real MCP
client against a real WebSocket, with an injected clock so the grace window and the
idle timeout are testable in microseconds.
