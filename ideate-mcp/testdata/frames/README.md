# Golden frames

Every frame the Agent Link wire contract can carry, one file each, as it appears
on the socket.

They exist because the contract is now written **twice**: once as TypeScript in
`app/lib/agentProtocol.ts`, once as Go structs in
`ideate-mcp/internal/protocol`. Before protocol 3 the same TypeScript module
compiled under both programs and the compiler kept them identical; nothing does
that any more, so these files are the guard, and they only work if all three
locks are held:

1. `app/lib/agentFrames.test.ts` builds each frame as a **typed TypeScript
   literal** and asserts it deep-equals the fixture. `tsc` checks the literal, so
   a change to the TS types forces a change here.
2. The Go tests (`internal/protocol`) decode every fixture with
   `DisallowUnknownFields` and re-encode it, asserting the bytes mean the same
   thing. A field Go is missing, has misnamed, or drops on the way out fails.
3. A frame with no fixture is checked by neither, so **add the fixture in the
   same change as the frame** — not afterwards. That ordering is the whole
   mechanism; a fixture written later is written against whatever the code
   already does, which is what it was supposed to be checking.

Round-tripping is why optionality matters here as much as naming. `read` with no
`path` and `scene_get` with `full: false` are separate fixtures precisely because
a Go `string`/`bool` with `omitempty` would round-trip both of them wrong.

Which is also why every command that takes an optional `path` has **two**
fixtures, one with the key and one without. Since protocol 4 that is `read`,
`edit`, `write`, `check`, `scene_get` and `scene_edit`, and the pair matters more
here than anywhere else in this directory: the two spellings do not name the same
document. A field silently dropped on the way out does not fail — it edits
whatever the human happens to have open instead of the file the agent asked for.
