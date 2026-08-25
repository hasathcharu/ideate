import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type EditResult,
  type ServerFrame,
} from './agentProtocol'

/**
 * The TypeScript half of the cross-language wire guard.
 *
 * `lib/agentProtocol.ts` used to compile under two tsconfigs — the browser's and
 * the MCP server's — so the compiler itself guaranteed the two ends of Agent Link
 * agreed on the frame shapes. Protocol 3 replaced the Node server with a Go one,
 * and that guarantee went with it: the contract is now written twice, in two
 * languages, and nothing mechanical connects them.
 *
 * `ideate-mcp/testdata/frames/` is what replaces it. Each frame below is written
 * as a **typed literal**, so `tsc` rejects it if the declarations move, and then
 * asserted equal to the fixture on disk. The Go tests decode the same files with
 * unknown fields disallowed and re-encode them. Change the TS type and this test
 * fails; update the fixture and the Go test fails; the drift has nowhere to hide.
 *
 * So the literals below must stay literals. Deriving one from the fixture it is
 * being compared against (`const frame = fixture('server-ready') as ServerFrame`)
 * would assert that a file equals itself and typecheck nothing at all.
 */

const FRAMES_DIR = join(import.meta.dirname, '..', '..', 'ideate-mcp', 'testdata', 'frames')

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FRAMES_DIR, `${name}.json`), 'utf8'))
}

/** Named rather than inlined so the failure message says which frame drifted. */
function matches(name: string, frame: ServerFrame | ClientFrame): void {
  expect(fixture(name), `frame fixture ${name}.json`).toEqual(frame)
}

describe('server frames', () => {
  it('ready', () => matches('server-ready', { t: 'ready' }))

  it('attached', () => matches('server-attached', { t: 'attached', agent: 'Claude Code' }))

  // `agent` is present-and-null, not absent: the agent may decline to name itself,
  // and the tab distinguishes "anonymous" from a frame that forgot the field.
  it('attached, anonymous', () =>
    matches('server-attached-anonymous', { t: 'attached', agent: null }))

  it('detached', () => matches('server-detached', { t: 'detached' }))

  it('req status', () => matches('server-req-status', { t: 'req', id: 1, command: { cmd: 'status' } }))

  it('req list_files', () =>
    matches('server-req-list-files', { t: 'req', id: 2, command: { cmd: 'list_files' } }))

  // The two `read` shapes are separate fixtures because the difference between
  // them is an *absent* key: no path means the open working copy, a path means
  // that file as committed. A serializer that turns the first into `path: ""`
  // silently changes which document is read.
  it('req read (open document)', () =>
    matches('server-req-read-open', { t: 'req', id: 3, command: { cmd: 'read' } }))

  it('req read (path)', () =>
    matches('server-req-read-path', {
      t: 'req',
      id: 4,
      command: { cmd: 'read', path: 'docs/architecture.md' },
    }))

  it('req edit', () =>
    matches('server-req-edit', {
      t: 'req',
      id: 5,
      command: {
        cmd: 'edit',
        edits: [
          { oldText: 'A --> B', newText: 'A --> C' },
          { oldText: '  ', newText: '\t', replaceAll: true },
        ],
      },
    }))

  // Protocol 4: every command that names a document has a with-path and a
  // without-path shape, and the pair is load-bearing for the same reason `read`'s
  // was — except worse. A dropped `path` on `read` returns the wrong document,
  // which is visible; a dropped `path` on `edit` *changes* the wrong document.
  it('req edit (path)', () =>
    matches('server-req-edit-path', {
      t: 'req',
      id: 12,
      command: {
        cmd: 'edit',
        path: 'docs/architecture.md',
        edits: [{ oldText: 'A --> B', newText: 'A --> C' }],
      },
    }))

  it('req write', () =>
    matches('server-req-write', {
      t: 'req',
      id: 6,
      command: { cmd: 'write', text: 'flowchart TD\n  A --> B\n' },
    }))

  it('req write (path)', () =>
    matches('server-req-write-path', {
      t: 'req',
      id: 13,
      command: { cmd: 'write', path: 'diagrams/new.mmd', text: 'flowchart TD\n  A --> B\n' },
    }))

  it('req open', () =>
    matches('server-req-open', {
      t: 'req',
      id: 7,
      command: { cmd: 'open', path: 'diagrams/flow.mmd' },
    }))

  it('req create_file', () =>
    matches('server-req-create-file', {
      t: 'req',
      id: 8,
      command: { cmd: 'create_file', path: 'notes/untitled.md', content: '# Untitled\n' },
    }))

  it('req create_canvas', () =>
    matches('server-req-create-canvas', {
      t: 'req',
      id: 17,
      command: {
        cmd: 'create_canvas',
        path: 'canvas/onboarding.excalidraw',
        ops: [
          { op: 'add', id: 'box-a', type: 'rectangle', x: 0, y: 0, text: 'Sign up' },
          { op: 'add', id: 'box-b', type: 'rectangle', x: 300, y: 0, text: 'Verify' },
          { op: 'add', type: 'arrow', x: 0, y: 0, start: 'box-a', end: 'box-b' },
        ],
      },
    }))

  // Absent `ops` rather than an empty array, for the same reason `read` has a
  // no-path fixture: a Go slice with `omitempty` round-trips both spellings to the
  // same bytes, and "open me a blank canvas" is a request in its own right.
  it('req create_canvas (blank)', () =>
    matches('server-req-create-canvas-blank', {
      t: 'req',
      id: 18,
      command: { cmd: 'create_canvas', path: 'canvas/blank.excalidraw' },
    }))

  it('req check', () => matches('server-req-check', { t: 'req', id: 9, command: { cmd: 'check' } }))

  it('req check (path)', () =>
    matches('server-req-check-path', {
      t: 'req',
      id: 14,
      command: { cmd: 'check', path: 'docs/architecture.md' },
    }))

  // `full: false` present rather than omitted, for the same reason as `read`: a Go
  // `bool` with `omitempty` drops it, and "summary only" then becomes
  // indistinguishable from "the field was never sent".
  it('req scene_get', () =>
    matches('server-req-scene-get', {
      t: 'req',
      id: 10,
      command: { cmd: 'scene_get', full: false },
    }))

  it('req scene_get (path)', () =>
    matches('server-req-scene-get-path', {
      t: 'req',
      id: 15,
      command: { cmd: 'scene_get', path: 'canvas/sketch.excalidraw', full: false },
    }))

  it('req scene_edit', () =>
    matches('server-req-scene-edit', {
      t: 'req',
      id: 11,
      command: {
        cmd: 'scene_edit',
        ops: [
          {
            op: 'add',
            id: 'box-a',
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 160,
            height: 80,
            text: 'Start',
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            fillStyle: 'solid',
            strokeWidth: 2,
            roughness: 0,
          },
          { op: 'add', id: 'link', type: 'arrow', x: 0, y: 0, start: 'box-a', end: 'box-b' },
          {
            op: 'add',
            type: 'line',
            x: 10,
            y: 20,
            points: [
              { x: 0, y: 0 },
              { x: 40, y: 60 },
            ],
          },
          { op: 'update', id: 'box-b', x: 300, text: 'Finish' },
          { op: 'delete', id: 'stale' },
        ],
      },
    }))

  it('req scene_edit (path)', () =>
    matches('server-req-scene-edit-path', {
      t: 'req',
      id: 16,
      command: {
        cmd: 'scene_edit',
        path: 'canvas/sketch.excalidraw',
        ops: [{ op: 'add', type: 'rectangle', x: 40, y: 40, text: 'Start' }],
      },
    }))

  // The layout ops, and one `gap: 0` among them on purpose. It is the shape this
  // whole file exists to catch: a Go `float64` with `omitempty` drops a zero, and
  // "butt these two together" arrives at the tab as "equalize what is already
  // there" — a different drawing, from a frame that parsed cleanly.
  it('req scene_edit (layout ops)', () =>
    matches('server-req-scene-edit-layout', {
      t: 'req',
      id: 21,
      command: {
        cmd: 'scene_edit',
        path: 'canvas/sketch.excalidraw',
        ops: [
          { op: 'align', ids: ['box-a', 'box-b', 'box-c'], axis: 'left' },
          { op: 'distribute', ids: ['box-a', 'box-b', 'box-c'], axis: 'y' },
          { op: 'distribute', ids: ['box-a', 'box-b'], axis: 'x', gap: 0 },
        ],
      },
    }))

  it('req scene_render', () =>
    matches('server-req-scene-render', { t: 'req', id: 19, command: { cmd: 'scene_render' } }))

  it('req scene_render (path)', () =>
    matches('server-req-scene-render-path', {
      t: 'req',
      id: 20,
      command: { cmd: 'scene_render', path: 'canvas/sketch.excalidraw' },
    }))
})

describe('client frames', () => {
  it('hello', () =>
    matches('client-hello', { t: 'hello', code: 'K7QM4XZP', protocol: PROTOCOL_VERSION }))

  // `data` is an `EditResult`, annotated so the fixture is checked against the
  // declaration rather than against `unknown` — `ClientFrame` types the field as
  // `unknown`, so the two fields protocol 4 added to every mutating result would
  // otherwise be typechecked by nothing at all.
  it('res ok', () =>
    matches('client-res-ok', {
      t: 'res',
      id: 5,
      ok: true,
      data: {
        path: 'diagrams/flow.mmd',
        created: false,
        applied: 2,
        lineCount: 12,
        diagnostics: [],
      } satisfies EditResult,
    }))

  it('res error', () =>
    matches('client-res-error', {
      t: 'res',
      id: 5,
      ok: false,
      message: 'No match for "A --> B" in the document.',
    }))

  it('event state', () =>
    matches('client-event-state', {
      t: 'event',
      name: 'state',
      state: {
        mode: 'github',
        repo: {
          owner: 'hasathcharu',
          name: 'ideate',
          branch: 'v3',
          defaultBranch: 'main',
        },
        openPath: 'diagrams/flow.mmd',
        kind: 'mermaid',
        dirty: true,
        lineCount: 12,
        charCount: 214,
        theme: { name: 'tokyo-night', mode: 'dark' },
      },
    }))
})

// The fixture carries the version the Go side is built against; a bump that only
// lands on one side of the wire is exactly the drift these files exist to catch.
describe('protocol version', () => {
  it('matches the hello fixture', () => {
    expect((fixture('client-hello') as { protocol: number }).protocol).toBe(PROTOCOL_VERSION)
  })
})
