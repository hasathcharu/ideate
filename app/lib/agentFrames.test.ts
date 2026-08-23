import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
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
 * `ideate-relay/testdata/frames/` is what replaces it. Each frame below is written
 * as a **typed literal**, so `tsc` rejects it if the declarations move, and then
 * asserted equal to the fixture on disk. The Go tests decode the same files with
 * unknown fields disallowed and re-encode them. Change the TS type and this test
 * fails; update the fixture and the Go test fails; the drift has nowhere to hide.
 *
 * So the literals below must stay literals. Deriving one from the fixture it is
 * being compared against (`const frame = fixture('server-ready') as ServerFrame`)
 * would assert that a file equals itself and typecheck nothing at all.
 */

const FRAMES_DIR = join(import.meta.dirname, '..', '..', 'ideate-relay', 'testdata', 'frames')

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

  it('req write', () =>
    matches('server-req-write', {
      t: 'req',
      id: 6,
      command: { cmd: 'write', text: 'flowchart TD\n  A --> B\n' },
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

  it('req check', () => matches('server-req-check', { t: 'req', id: 9, command: { cmd: 'check' } }))

  // `full: false` present rather than omitted, for the same reason as `read`: a Go
  // `bool` with `omitempty` drops it, and "summary only" then becomes
  // indistinguishable from "the field was never sent".
  it('req scene_get', () =>
    matches('server-req-scene-get', {
      t: 'req',
      id: 10,
      command: { cmd: 'scene_get', full: false },
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
})

describe('client frames', () => {
  it('hello', () =>
    matches('client-hello', { t: 'hello', code: 'K7QM4XZP', protocol: PROTOCOL_VERSION }))

  it('res ok', () =>
    matches('client-res-ok', {
      t: 'res',
      id: 5,
      ok: true,
      data: { applied: 2, lineCount: 12, diagnostics: [] },
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
