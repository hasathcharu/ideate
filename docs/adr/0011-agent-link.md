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

`ideate-mcp/` is a Model Context Protocol server that hands a coding agent **a
document in the browser right now**, not a file on disk. That is the whole point:
the agent edits, mermaid renders, and the renderer's verdict comes back in the
result of the agent's own tool call, so a broken diagram gets fixed in the same
turn. An agent editing files finds out when a human next opens them.

Since protocol 4 that document need not be the one on screen — see "Every document
tool takes a path" below — but it is still a document *in the tab*, which is what
keeps the renderer in the loop.

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
`ideate_create_file` and `ideate_create_canvas` are offered because they are genuinely
local: they do exactly what the create prompt does, leaving an uncommitted document with
`loadedSha === null`. The blast radius is the working copy: on screen, and one ⌘Z away.

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

### A redeployed tool list, and the one event that reveals a stale one

The tools are registered once at boot, so no process ever observes its own list
changing. A *client* does: it lists the tools at connect and keeps them for its
session, so a service redeployed with a new tool leaves every connected agent driving
the surface of the build it met. Nothing in the request/response flow corrects that —
the agent simply never learns the tool exists, which is indistinguishable from the
tool not existing.

`tools: {listChanged: true}` was always advertised (the SDK infers it from a server
having tools; `tools.Capabilities` now states it instead, because a mechanism resting
on an inference is a mechanism that can be switched off by an upstream refactor). But
until SEP-2575 it was undeliverable **here**: stateless mode answers `GET /mcp` with
405 and every POST's session dies with its request, so there was no channel for a
server-initiated notification. SEP-2575 adds one and adds it *only* for stateless
servers — `subscriptions/listen` is a long-lived POST whose SSE stream is the channel.
That is exactly this transport.

The capability was never the missing piece, though; the **trigger** was. There is one
observable that says somebody may be holding an older list: a client subscribing. It
arrives either because the client is new — it just listed the tools, so a notification
costs it one redundant `tools/list` — or because its stream died and it came back,
which after a deploy is precisely the client holding the stale list. So a subscription
is answered with a notification (`refresh.go`), coalesced on the trailing edge because
a deploy brings every client back at once, and capped so a steady trickle of
subscriptions cannot postpone the pulse forever. Silently never firing is the one
failure mode that looks exactly like the bug.

The notification has to be **provoked rather than sent**: the SDK owns the subscriber
map and exposes no "notify this session", so the only lever is re-registering a tool,
which `AddTool` treats as a change unconditionally. `Register` hands that closure over
built from the first tool it registers, so no tool definition is written twice for the
purpose.

A client that never subscribes still cannot be told, and for it the recourse is the
agent's own eyes: `ideate_status` reports `service.build` and `service.tools`, and the
tool description tells the agent to compare that list against the `ideate_` tools it
was given and to ask the human to reconnect if the service names one it lacks. Which
makes the reported list load-bearing — a test asserts it is exactly what `tools/list`
serves, because a wrong list is worse than no list.

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

### Every document tool takes a path, and the mutating ones require one

Protocol 4. Until then every tool meant "whatever the human is looking at", which made the
common case free and everything else impossible: an agent asked to fix six diagrams had to
`ideate_open` each one, dragging the human's editor to a different file six times and
losing their cursor each time. A `path` argument makes that work invisible to them.

The interesting part is *where the field is optional*, and the two answers are opposite:

- **`read`, `check`, `scene_get` — optional.** "What is on screen" is a real question, and
  answering it about the wrong document costs one wasted call.
- **`edit`, `write`, `scene_edit` — required.** The open document is not a stable address.
  The human keeps browsing while the agent works, so "the open document" means whichever
  file they clicked last, and an edit that lands on the wrong one is not something reading
  it again can undo. `AppShell.requirePath` refuses those.

The exemption is the **untitled** document, which has no path to name. Keying the refusal
on `openPath === null` rather than on "is a repo connected" is what makes the rule hold in
both modes — local mode has files now, and a connected repo still has an untitled
document. It also means an agent that meant the untitled document, while the human opened
a file mid-turn, is *refused* rather than silently redirected onto theirs. The wire keeps
the field optional in all six because only the tab knows which case it is in; the schema
says "required" in prose and `targetPathArgs` explains why the Go side does not enforce it
too.

`resolveTarget` is where a path becomes a document, and there are three places one can be
living: React state (the open one), a localStorage draft (never saved), or the saved store.
A draft is layered over the saved content whenever it differs, because the draft is what
the human would see if they opened it — answering with saved bytes is how an agent talks
itself into re-doing an edit it made one call earlier. It reads the draft *straight from
storage* rather than consulting `pendingPaths`, because a command that creates a file has
to be visible to the very next command and `createdPaths` only reaches `pendingPaths`
through a render.

**A path that matches no file is created.** `edit` seeds it from the starter template for
its extension and `scene_edit` from a blank canvas, so an agent can draw a new diagram in
one call; `write` creates it holding exactly the text given. `edit` resolves its anchors
*before* anything is written, so a failed anchor leaves the file uncreated — half a file
named after a template the agent never asked for is worse than no file.

**A background edit is only complete when the UI says so.** `writeBack` writes the draft
and adds the path to `dirtyPaths`, which is what lights the dot in the sidebar — and clears
both when an edit happens to restore the saved content, or the file stays flagged forever
over a difference of nothing. The same reasoning extended the once-per-workspace recovery
pass to seed `dirtyPaths` from the drafts on disk: the markers used to live only as long as
the tab, so an agent that edited six files nobody opened left the work in localStorage and
no sign of it on screen after a reload.

None of this touches GitHub, so rule 13 is intact: an agent's blast radius is still the
uncommitted working copy, now including working copies of files nobody has opened.

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

**Which is exactly the wrong dependency, because `scene_edit` exists to work on a
file nobody is looking at.** Waiting for a mounted editor could not serve its main
use, and `create_canvas` drew before it opened, so the commonest way to reach either
tool — an agent drawing while the human reads a markdown file — measured every label
against the substitute face. Verified in the browser: with no canvas mounted,
`Excalifont` is absent from `document.fonts` after six seconds of polling, and
`measureText` returns 184px for "Authentication Service" where a mounted editor
returns 220px.

So **the app registers the faces itself, at page load** (`lib/excalidrawFonts.ts`),
and the measurement stopped depending on what is on screen. Getting there needed the
declarations, which live in the bundle rather than in any stylesheet, so
`scripts/vendor-excalidraw-assets.mjs` — already copying the woff2 files — now also
lifts out the `@font-face` descriptors beside them. That is a real coupling to
minified internals, so every assumption it makes is asserted: an unresolvable
`unicode-range`, or a vendored file no descriptor accounts for, **fails the build**
with a message naming what it could not find. Shipping an app that measures text
wrong is the failure mode being designed against, and it is silent.

Three things fell out of the shape of the data:

- **The manifest is split in two, and the split has one family in it.** Xiaolai, the
  CJK fallback, is subset per CJK block: 209 faces and ~40KB gzipped of range
  bookkeeping, against 1.3KB for the other six families together. It gets its own
  manifest, fetched only when the text being measured actually contains CJK. Every
  visitor paying 40KB for glyphs almost none of them will type is exactly the kind of
  cost rule 8 exists to refuse.
- **Excalidraw's UI fonts are exempt, derived rather than named.** Assistant is a
  plain `@font-face` rule in `index.css`, not an entry in the JS registry — a
  different mechanism for a font that never holds scene text. The build reads the
  stylesheet to find out which files those are, so a family moving between the two
  mechanisms upstream is still noticed.
- **Duplicate registration is harmless and was verified, not assumed.** When the
  editor does mount it adds its own copies, because it checks `document.fonts.has`
  against its own `FontFace` objects. Measured with all 14 Excalifont faces
  registered: still 220px, and a real scene renders identically.

`awaitTextFonts` is a plain load again as a result — no poll, no timeout — and it
still **returns whether it succeeded**, which the caller turns into a
`font_unavailable` warning. Silence was the original defect: the drawing came back
looking fine to the agent and clipped to the human. The warning now means the app
failed to fetch its own assets rather than "no canvas was open", which is a bug
report rather than a workaround. `create_canvas` went back to drawing once. Note that
`document.fonts.check` cannot stand in for knowing the faces are registered: it
answers **true** for a family with no faces at all, because an unmatched family falls
through to a system font and a system font is always ready.

An earlier version of this fix had `create_canvas` draw twice — once to validate,
then again on the canvas it had just opened. It is worth recording why that was
abandoned rather than kept as a belt: it only ever helped the one tool that opens
something, and the mount it waited for took 3.7s in dev against the 3s budget it was
given, so it was a slow fix that was also flaky.

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

### A canvas has no renderer to refuse it, so it gets a linter instead

`lib/sceneLint.ts` is `ideate_check` for a drawing, and it exists because of an
asymmetry that had been sitting in the tool surface from the start. A mermaid diagram
is *parsed* — the agent writes a graph, dagre lays it out, and a mistake comes back as
a parse error in the result of the agent's own tool call. A scene has neither: it has
no parser to fail and no layout engine to appeal to, and `scene_edit` takes absolute
pixel coordinates. The agent **is** the layout engine, working blind, and every layout
mistake it makes is a silent success. Overlapping boxes, arrows drawn straight through
a shape, a label wider than the box holding it, a column of boxes at x = 100, 100, 103
— all of it committed happily and none of it visible to the caller. That is the whole
of why agent-drawn canvases read badly, and most of it is not the agent's arithmetic.

So `scene_edit`, `create_canvas` and `scene_get` all answer with `warnings`. Design
constraints, in the order they mattered:

- **Warnings, never errors.** Most findings are judgements — a shape inside a shape is
  a mistake or a deliberate group, and only the caller knows which — so full
  containment is not reported at all and nothing here can refuse an edit. Failing a
  drawing over a guess would be worse than drawing it.
- **Every message carries the ids and a number.** "The label is wider than the
  rectangle holding it (220×25 inside 190×90 of room) … make it at least 230 wide" is
  actionable in one more call; "layout problem" is not. `ids` is there so the
  follow-up `update` op needs no second `scene_get`.
- **The whole scene, not the diff.** A new box overlapping an old one is a finding
  about both, and the caller is the only party who can move either.
- **Capped, and ordered by how likely a finding is to be real** — six per kind, 24 in
  all, checks called worst-first — so a scene with forty overlapping boxes is told
  once and a truncated list is truncated from the least useful end.
- **`font_unavailable` sorts first**, because it explains away every `label_overflow`
  under it: a box measured against the wrong face is too small for reasons that have
  nothing to do with the number the caller passed.
- **A check that fires on good input is one an agent learns to ignore.** Hence full
  containment is not an `overlap`, and `misaligned` skips a direction entirely when the
  pair is *exactly* aligned on any axis in it — a left-aligned column of boxes
  auto-sized to their own labels has three different widths and therefore three right
  edges a couple of pixels apart, and that is the best-laid-out drawing an agent can
  produce, not a defect.
- **Pure geometry, no value import** (rule 8). Every check reads fields off elements
  the converter has already produced, which is what lets it run inside both
  `applySceneOps` and `summarizeScene` without either becoming a dynamic-import site.

**And no `PROTOCOL_VERSION` bump**, unlike the theme field that forced 5. The tab
always sends the field, empty when it found nothing, so an older tab omitting it is
*distinguishable on the wire* from a newer tab reporting a clean scene — which is
exactly what `theme` could not manage. Nothing here changes what a command does
either, so a stale tab costs its agent some advice and no correctness. A bump would
have stranded a user who has no beta label telling them to expect one.

What this deliberately does **not** do is lay the drawing out. The arrows are still
routed centre to centre with `focus: 0`, so several arrows into one shape still
converge on the same line, and `route` still emits two points and cannot go round
anything — `arrow_crosses` and `arrow_duplicate` report exactly the defects our own
router causes. Telling the caller was the cheap half; a real router, spread bindings,
grid snapping and relative placement are all still open.

### The agent is told the theme, because the theme is not in the document

Protocol 5. An agent asked to color a node used to have exactly one way to do it —
write the color into the file — and that is the one thing it should not do. A mermaid
theme lives in `AppConfig.mermaidConfig` and is **injected at render time**; the file
on the branch holds bare ```mermaid fences. So `style A fill:#f00` does not color a
node, it opts that node out of every theme the human picks afterwards, and there was
nothing anywhere in the tool surface to say so. Adding `theme` to `BridgeState` and
the reasoning to `ideate_edit`'s description is the whole fix: the agent can see there
is a palette, and it is told the palette is applied later.

**A canvas is the opposite case, and the same field carries it.** Excalidraw stores a
literal `strokeColor` on every element — there is no token layer to re-resolve, so
nothing about a scene *can* follow the theme. What makes scenes look theme-responsive
is rule 11: dark mode is `filter: invert(93%) hue-rotate(180deg)` over the whole
canvas. Which means an agent being helpful in the obvious way — the app is dark, so
draw in light colors — produces a drawing that inverts to dark-on-dark. Hence
`theme.mode` and the schema notes on the color fields: author light values, always,
and the display handles the rest. The mermaid theme only ever contributes the canvas
*mode* and the background painted behind it, never an element color.

`SceneElementSummary` grew `strokeColor`/`backgroundColor` for the consequence of all
that: a scene *is* its colors, so matching the neighbours means having seen them, and
the only way to see them before was `full` — the entire scene JSON, to answer a
question about two hex strings.

Both are nullable, and neither is defaulted. A theme `name` is null when no theme is
set and mermaid's own look applies; an element color is null when the file does not
carry one. Substituting Excalidraw's default here would report a color the element
does not have, which is worse than reporting nothing.

### `ideate_create_canvas` exists because `scene_edit` deliberately will not open a file

Both halves already existed and neither did the job. `create_file` could once make a
`.excalidraw` file, but its `content` is raw scene JSON — element records with ids,
bindings, seeds and measured text boxes — which is not something to ask a model to
author, and omitting it only opens an empty canvas nobody asked to look at. `scene_edit`
creates the file its path names and draws into it properly, but **leaves the editor
where it is**, because it exists to work on files the human is not looking at, and
yanking their editor around is the cost that buys.

A brand-new canvas is the one case where that trade inverts: there is nothing to yank
them away from, and a drawing nobody is shown may as well not have been drawn. So
`create_canvas` is `create_file`'s path handling with `scene_edit`'s ops, and its last
two lines are the reason it is a separate tool — it opens what it made.

The ops are validated **twice on purpose**: `internal/tools.createCanvas` refuses a bad
op before the tab is asked for anything, so a malformed drawing cannot leave a blank
canvas open in the human's editor, and `applySceneOps` runs before anything is written
so a failure leaves no half-made file. Same all-or-nothing rule `edit` follows. The
extension check is also on both sides, because the tab is the side that would otherwise
open a markdown document in response to a request to draw.

**`create_file` refuses `.excalidraw` for the mirror-image reason**, on both sides too.
Once `create_canvas` exists, the only thing the old path bought was an empty canvas or a
hand-authored scene file, and both are worse than the retry the refusal costs. So the
two creating tools now partition the extensions between them rather than overlapping on
one: `create_file` takes `.mmd`/`.mermaid`/`.md`/`.markdown`, `create_canvas` takes
`.excalidraw`, and each refusal names the other tool. This needs no `PROTOCOL_VERSION`
bump — the `create_file` frame is unchanged and the refusal is an ordinary tool error.

`ops` is optional, and absent rather than empty is a request in its own right — "give
me a blank canvas" — which is why it has its own fixture beside the drawn one.

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
- **restart the service while an agent is connected, having added a tool first** —
  the new tool appears in the running agent's own list without anybody reconnecting
  anything. `go test` covers the notification leaving the service; only a real client
  proves it re-lists on receipt. If it does not, check that the client negotiated
  SEP-2575 at all — a client that never opens a `subscriptions/listen` stream cannot
  be told, and its fallback is `ideate_status`'s `service.tools`
- `MAX_WS_SESSIONS=1`, then a second tab → 4005, the modal shows the capacity copy
  with a working Retry, and `/v1/capacity` returns 529
- **edits sent faster than React commits** — chain each edit's anchor on what the
  previous one produced, so a dropped edit makes the *next* one fail loudly rather
  than quietly ending up short
- **Safari**, which is the reason for the break
- a `.excalidraw` scene through the scene tools, and a markdown document with a
  broken ```mermaid fence
- **`ideate_edit` with a path to a file nobody has opened** — the sidebar's dirty dot
  appears, the editor does not move, opening the file afterwards shows the edit, and
  reloading keeps both the edit and the dot
- **an edit that restores the saved content** — the dot goes out and the draft is gone
- **`ideate_edit`/`ideate_write`/`ideate_scene_edit` with no path while a file is
  open** — refused, naming the tool that reports the open path; and *accepted* on the
  untitled document
- **a path that matches no file** — created by `edit`/`write`/`scene_edit`, and *not*
  created when the edit's anchor fails
- **local mode with files**: create, save, rename, delete, and the same agent matrix
  against `km:file:` instead of a branch
- **`ideate_status` after changing the Theme dropdown** — the reported `name` follows
  it through preset → Custom (a hand-edited palette) → None, and `mode` flips with a
  dark preset
- **`ideate_create_canvas`** — the canvas opens with the drawing on it, a second call
  on the same path is refused, a `.md` path is refused, a bad op leaves no file behind
  and no blank canvas in the editor, and no ops at all opens an empty one
- **labels fit their boxes with no canvas ever opened** — the case the page-load font
  registration exists for. Load the editor on a markdown document, then `scene_edit`
  a `.excalidraw` path with long labels ("Authentication Service" and longer): no
  `label_overflow`, no `font_unavailable`, and nothing clips when the file is opened
  afterwards. The old behaviour is reproducible by blocking
  `/excalidraw-assets/font-faces.json`, which should produce `font_unavailable` rather
  than a silently narrow box
- **`warnings` come back from all three scene tools, and are `[]` rather than absent
  on a clean scene.** Then earn each kind: two boxes 20px apart (`overlap`), three in
  a row with an arrow from the first to the last (`arrow_crosses`), two arrows between
  the same pair (`arrow_duplicate`), a `text` element placed on top of a rectangle
  instead of as its label (`text_not_bound`), boxes at x = 100 and x = 103
  (`misaligned`). A well-laid-out drawing must report **nothing** — a linter that
  fires on good input is one an agent learns to ignore
