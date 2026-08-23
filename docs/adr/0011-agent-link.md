# 0011. Agent Link: the remote service, the pairing code, and the wire contract

**Status** accepted &nbsp;·&nbsp; **Touches** `ideate-mcp/, app/lib/agentProtocol.ts, app/lib/agentLink.ts, app/lib/textEdit.ts, app/lib/sceneEdit.ts`

The invariants this record justifies are listed in [`CLAUDE.md`](../../CLAUDE.md). This file holds the reasoning behind them — read it before changing any of them, and update it here when a decision actually changes.

---

## Rule 12

**Agent Link: the pairing code is the credential, and TLS is not optional.**
Protocol 3 deleted the old token route along with the property that used to
guard it (its *absence* of CORS headers). The service now issues nothing: the
tab generates its own code client-side and the service buckets by
`sha256(code)`, so a hostile page can generate a code and pair with itself,
which is harmless — it cannot guess the user's. What replaces the old rule:
- **The service URL must be `https:`, or `http:` on `localhost`/`127.0.0.1`
  port 7391.** Enforced on *both* sides, in one implementation each —
  `validateMcpOrigin` (`lib/mcpOrigin.ts`) and
  `internal/config.ValidateMCPOrigin`. Plaintext anywhere else puts the code
  and every document the tab reads on the wire in the clear.
- **The code never reaches a URL, a query string, or a log line.** Logs carry
  an 8-character prefix of the hash at most.
- **The TS↔Go wire contract is guarded only by `ideate-mcp/testdata/frames/`.**
  Add a frame, add its fixture in the same change — see "The wire contract is
  written twice" below.
- **Add no CORS configuration to the service.** Its two callers are a browser
  opening a WebSocket (no same-origin policy, so no preflight) and an MCP
  client, which is not a browser.

## Rule 13

**No agent tool may write to GitHub.** There is no commit tool, and rename and
delete are deliberately not exposed either, because in this app they *are*
commits. An agent's blast radius is the uncommitted working copy.

## Agent Link — an agent drives the live editor

**The beta label is gone from the UI** (it was a badge on `AgentLinkModal`'s title
and a word in every toolbar tooltip), so the licence it carried — change
`PROTOCOL_VERSION` and the tool surface with no migration path — is gone with it.
What has not changed is the mechanism: the two sides refuse to talk on a mismatch
(`CLOSE_PROTOCOL_MISMATCH`), so a bump is a loud, diagnosable break rather than a
silent one. Which means **ship both ends of a bump together** — a version skew now
strands a user who has no label telling them to expect it.

`ideate-mcp/` is a Model Context Protocol server that hands a coding agent **the
document open in the browser right now**, not a file on disk. That is the whole
point: the agent edits, mermaid renders, and the renderer's verdict comes back in
the result of the agent's own tool call, so a broken diagram gets fixed in the same
turn. An agent editing files finds out when a human next opens them.

### One remote service, and why the socket turned around

```
agent ──MCP Streamable HTTP──► ideate-mcp (Go) ──WebSocket──► browser tab
```

Until protocol 3 this was inverted: the MCP server was a Node process on the user's
own machine that **listened** on `ws://127.0.0.1:7391-7395`, and the tab dialled out
to it. That was forced rather than chosen — a web page cannot open a listening
socket — and it had to go, for reasons no amount of care would have fixed:

- **Safari could not use it at all.** No loopback exemption for mixed content, so
  `ws://127.0.0.1` from an `https://` page is blocked outright. Chrome's Local
  Network Access work is heading the same way.
- **Only an agent on the same machine could reach the tab.** Containers,
  Codespaces, SSH boxes and browser-based agents were all impossible.
- Everything awkward about the old design — the port walk, the `Origin` allowlist
  doing security work, the whole JWT/JWKS apparatus — existed *only* to make a
  loopback listener safe. Inverting the socket deleted all of it in one go.

The tab is still the WebSocket client; it just dials a service instead of loopback.
**A pairing code the tab generates, and the human hands to their agent, joins the
two halves.** The honest cost, and it belongs in the README: **Agent Link no longer
works offline.**

`lib/agentProtocol.ts` is the wire contract. It has lost its old "must compile under
two tsconfigs" rule — the app is its only TypeScript consumer now — and gained a
cross-language mirror in its place; see below.

### Which tab, and whose decision

Two deliberate steps gate this, one on each side, and they answer different
questions. This is unchanged by the transport, and it is the part most worth not
breaking.

**Which tab** is the human's answer, given by switching Agent Link on there and
handing over that tab's code — hence the per-tab `sessionStorage` scoping in rule 3.
One code holds one tab (`CLOSE_SLOT_TAKEN` turns away any second one), so the
service never chooses.

**Whether to drive it** is the agent's answer, given by calling `ideate_connect`. A
paired tab is parked as *waiting* and every command that touches the document is
refused until then, because a pairing code existing is nobody's decision: adopting
whichever tab was paired would mean editing a human's document with no one having
chosen to. `ideate_status` is the one tool allowed through unattached, and it returns
metadata only — never content — so an agent can say what attaching would give it
without first helping itself.

`lib/agentLink.ts` therefore has these live states, and conflating them makes the
toolbar lie: `paired` (this tab holds its code, nothing can touch the document) is
not `attached` (an agent claimed it and can edit now).

**`full` is its own state and not a flavour of `blocked`**, because the two want
opposite behaviour. `blocked` (a protocol mismatch) means retrying is pointless;
capacity frees up, so it is not — but hammering a full service is not how to wait
for it either. So `full` stops the automatic loop and waits for an explicit Retry,
which also holds the message still long enough to read.

### Security: the code is the credential

WebSockets have **no CORS and no same-origin policy**, and that fact used to drive
the whole design. It no longer does, because there is nothing on the socket worth
claiming: the service issues nothing, holds nothing durable, and buckets purely by
`sha256(code)`. A hostile page can generate its own code and pair with itself, which
is harmless. It cannot guess the user's.

So the old "the security is the absence of CORS headers on the token route" property
did not move — it **disappeared**, along with the route. What carries the weight now:

1. **The pairing code**, 8 characters of Crockford base32 (2^40), which only holds up
   because guesses are rationed: a per-IP token bucket on `/mcp` and `/v1/tab`, plus a
   much tighter per-IP counter on codes matching no tab. The general limiter has to run
   *before* the body is parsed, since the code arrives as a tool argument and cannot be
   read until after — which is why it is keyed on the address rather than on the code.
2. **TLS**, per rule 12, enforced on both sides in one implementation each.

The `Origin` allowlist on the tab handshake survives as a **soft** control: it stops
the service being used as free infrastructure by unrelated pages. It is not the
security control, and the code comments say so — a browser cannot forge `Origin` but
a local process can, and neither can guess a code.

**There is no commit tool, and rename/delete are not exposed either** — in this app
those *are* commits (`renameFile`/`deletePaths` push to the branch), so exposing them
would break the guarantee that an agent cannot write to the user's repository.
`ideate_create_file` is offered because it is genuinely local: it does exactly what
the create prompt does, leaving an uncommitted document with `loadedSha === null`.
The blast radius is the working copy: on screen, and one ⌘Z away.

The standing risk is prompt injection, and none of this changes it: an agent reads
documents from the user's repo, and a `.md` file can contain instructions aimed at
it. That is why there is no commit tool.

### The code is a tool argument, not a header — and that is the point

Every tool takes a required `code`. An `Authorization: Bearer` header is the more
standard remote-MCP shape and would keep the credential out of the model's context,
but a header lives in client config — so switching which tab is driven would mean
re-running `claude mcp add` and tearing down the MCP connection. **Switching tabs
mid-session is a hard requirement**, and only an argument gives it: the human names a
different code and the next call lands on a different tab.

The `code` argument's *description* is what makes that work in practice, so keep its
last clause. Accepted costs: the code appears repeatedly in agent transcripts (the
same exposure as typing it into chat), and the bucket cannot be resolved until the
body is parsed.

MCP runs **stateless** — no `Mcp-Session-Id` binding, since every request carries its
own code. That removes a map and a session lifecycle. It does *not* make the service
stateless: the registry of live tab sockets is irreducible, and both ends of a pairing
must live in one process to be piped. Hence no Redis, no Postgres, and no horizontal
scaling without sharding — and no datastore either, because every record describes a
connection that dies with the process.

Losing the stateful session is why **attachment needs an idle timeout**: a stateful
server would detach on client teardown for free, and without it a killed agent leaves
the toolbar claiming somebody can edit the document. It is wanted regardless — a
stateful client can also vanish without a clean teardown.

### Two things the transport cannot say out loud

- **529 cannot reach a browser.** A rejected WebSocket handshake surfaces in the tab
  as `onclose` 1006 with an empty reason, indistinguishable from the service being
  down. So the capacity refusal reaches the tab as `CLOSE_SERVICE_FULL` on an
  **accepted** socket, and the readable 529 lives on `/v1/capacity` where a
  non-browser client can see it.
- **A grace-window rejoin must re-send `attached`.** A bucket outlives its tab socket
  by `TAB_GRACE`, so a reload keeps the agent's attachment — but the reloaded tab has
  no memory of it, and without the re-send the toolbar would show nobody attached
  while an agent carried on editing.

### The wire contract is written twice

`lib/agentProtocol.ts` and `ideate-mcp/internal/protocol` are hand-mirrored, and the
compiler that used to hold them together is gone. `ideate-mcp/testdata/frames/` is
the replacement, and it only works if all three locks are held:

1. `lib/agentFrames.test.ts` builds each frame as a **typed TypeScript literal** and
   asserts it deep-equals the fixture. `tsc` checks the literal, so moving the TS types
   forces a change here.
2. The Go tests decode every fixture with `DisallowUnknownFields` and re-encode it. A
   field Go is missing, has misnamed, or drops on the way out fails.
3. **A frame with no fixture is checked by neither**, so add the fixture in the same
   change as the frame. A fixture written afterwards is written against whatever the
   code already does, which is what it was supposed to be checking.

Round-tripping is why optionality is load-bearing on the Go side: `read` with no
`path` and `scene_get` with `full: false` have their own fixtures precisely because a
bare `string`/`bool` with `omitempty` round-trips both of them wrong.

### Edits land as CodeMirror transactions, and the echo guard is why they survive

`EditorHandle` (`components/Editor.tsx`) resolves every anchor against the live
document and dispatches **one** transaction, so a batch is one undo step, the
untouched parts keep their folds and cursor, and the dirty gutter and viewfinder
update through the paths they already use. `resolveEdits` (`lib/textEdit.ts`) is
shared with a fallback that goes through `setText` for when no editor is mounted
(a canvas is open, or the diff view has the pane) — refusing there instead would
make the tools mysteriously unavailable whenever the human was reading a diff.

Two things here were bugs found by running it, not by typechecking:

- **`emittedRef` — the echo guard.** The reconcile effect cannot tell an *external*
  `value` change (open a file, restore, `ideate_write`) from an *echo* of the
  editor's own output by value alone. React can commit a render carrying an older
  value *after* a newer programmatic edit already moved the document, and
  force-replacing the document with it silently discards that edit. Two agent edits
  arriving faster than React commits lost **every second one**. So the editor keeps
  a short history of what it emitted and drops an incoming value it finds there.
  Do not collapse this back into a single `lastValue` ref.
- **Diagnostics run on the text the edit *produced*.** `applyEdits` returns the new
  document and `check(text)` takes it, because `setText` only reaches React on the
  next render — reading state back here reported on the document as it was *before*
  the edit, so breaking a diagram looked clean and fixing it looked broken.

**Known, unfixed:** `ideate_write` immediately followed by `ideate_edit` can race.
`writeText` goes through React state while `applyEdits` resolves anchors against the
*live* CodeMirror document, so the edit can look for text the editor has not received
yet and fail with "oldText not found". It predates protocol 3 and the remote
transport makes it *less* likely, not more. The fix, if it is wanted, is to route
`writeText` through the editor handle when one is mounted.

### Scene edits go through `setText`, and route their own arrows

`lib/sceneEdit.ts` reaches `@excalidraw/excalidraw` only through a per-function
`await import` (rule 8), and hands back scene *text* — `CanvasInner` already ingests
an external `value` via `updateScene`, so dirty tracking (rule 9) and the file's own
stored background (rule 10) keep working with nothing added. Never a canvas ref.

**`convertToExcalidrawElements` binds arrows but does not route them.** Handed
`start`/`end` with no points it emits a 99px stub at the canvas origin: correctly
bound, and invisible nowhere near the shapes it joins. So geometry is computed here
(centre to centre, trimmed to each box edge plus a gap) and the binding is wired by
hand in both directions — `startBinding`/`endBinding` on the arrow *and* an entry in
each target's `boundElements`, or dragging the shape leaves the arrow behind. Doing
it ourselves is also what lets an arrow attach to something already on the canvas,
which the converter cannot do (it only resolves ids inside its own batch).

**Nothing that holds text may be measured before its font is loaded.** A shape's
size is decided at conversion time by Excalidraw's `redrawTextBoundingBox`, which
measures through a canvas 2D context set to `20px Excalifont, …` — and a canvas
silently substitutes a generic face for a font that has not loaded rather than
failing. Excalifont is handwriting and ~20% wider than that substitute
("Authentication Service": 184px against the fallback, 220px loaded), so every
generated box came out sized for a font it would not be drawn in, and clipped its
own label. Double-clicking the shape appeared to fix it because opening the text
editor puts the font on screen, which loads it, and Excalidraw re-measures on blur.
So `applySceneOps` awaits `awaitTextFonts` before it converts anything. Two things
that helper depends on: the faces are registered on `document.fonts` by the
*mounted* editor and not by importing the library (hence the bounded wait, not a
bare `load`), and each face is a per-glyph-range subset (hence passing the text, so
`load` fetches the subsets those characters need).

Which is also why **a text change re-measures the box around it** (`refit`), rather
than writing the new string in beside the old string's geometry. It runs the same
skeleton conversion the add path uses, because `measureText`, `wrapText` and
`redrawTextBoundingBox` are all unexported and re-deriving the wrap, the container
growth and the re-centring by hand is three chances to disagree with the renderer.
Only geometry is copied off the throwaway — and for an arrow, not even its width:
an arrow is sized by its `points`, and Excalidraw pointedly does not widen one to
fit a label.

The tool schema flattens the add/update/delete union into one object, because a JSON
Schema generated from a Go struct cannot express a discriminated union. That loses the
schema's ability to say "id is required for update"; `internal/tools.sceneOps` says it
instead, in a message naming the op and the missing field. A worse schema and a better
error — and the error is what the agent actually reads when it gets it wrong.

### Running it

The service is remote, so an MCP client needs a URL rather than a command:

```
claude mcp add --transport http ideate https://<service>/mcp
```

Run once. After that the **pairing code** is the only thing that changes, and it is
how the human points an agent at a different tab. A stdio-only client can front it
with `npx mcp-remote https://<service>/mcp`.

Locally, from a checkout:

```bash
npm run mcp:dev        # go run ./cmd/server on :7391
npm run dev            # the app
claude mcp add --transport http ideate-local http://localhost:7391/mcp
```

Without a checkout, the service is published as
`docker.io/hasathcharu/ideate-mcp` and takes no configuration:
`docker run --rm -p 7391:7391 hasathcharu/ideate-mcp`. The same command is
offered inside **Agent Link → Advanced options**, beside the field that points the
tab at the result — the docs link there is for the environment variables, not for
the one line that gets you running.

Then point the tab at it in **Agent Link → Advanced options**. `http://localhost:7391`
is the one plaintext origin either side accepts (rule 12); 7391 is the old bridge
port, kept because it is the number in everyone's muscle memory.



## Verifying it — not reachable by typecheck or build

**Agent Link's behaviour is not reachable by any of that**, and this is where the
bugs actually are. Four real ones have been found only by driving it: the
lost-every-second-edit race, diagnostics reporting on the pre-edit document, the Go
SDK's own 4MiB body limit silently overriding `MAX_BODY_BYTES`, and a close code
that could never reach the tab because cancelling a read tears the socket down
before the close frame goes out. So drive it, end to end, in `?mode=local` with no
repo connected:

```bash
npm run mcp:dev                                                     # :7391
NEXT_PUBLIC_MCP_ORIGIN=http://localhost:7391 npm run dev
claude mcp add --transport http ideate-local http://localhost:7391/mcp
```

Switch Agent Link on, read the code, `ideate_connect` with it, write a *broken*
diagram and confirm **the renderer's diagnostics come back in the tool result** —
that loop is the whole reason the feature exists. Then walk the matrix, none of
which typechecking can see:

- wrong code → refused; repeated wrong codes trip the limiter
- **two tabs, switching between them mid-session by naming the other code** — the
  requirement this design exists to serve
- Regenerate → the old code stops working, the new one works, no reconfiguration
- agent restart → same code still works, no re-pair
- service restart → both sides reconnect, one re-pair
- tab reload → rejoins inside `TAB_GRACE`, agent keeps its attachment
- kill the agent → the attachment idles out and the toolbar stops claiming an agent
  can edit
- `MAX_WS_SESSIONS=1`, then a second tab → 4005, the modal shows the capacity copy
  with a working Retry, and `/v1/capacity` returns 529
- **edits sent faster than React commits** — chain each edit's anchor on what the
  previous one produced, so a dropped edit makes the *next* one fail loudly rather
  than quietly ending up short
- **Safari**, which is the reason for the break
- a `.excalidraw` scene through the scene tools, and a markdown document with a
  broken ```mermaid fence
