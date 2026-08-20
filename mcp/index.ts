import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { BRIDGE_PORTS, type Command } from '../lib/agentProtocol.js'
import { Bridge } from './bridge.js'
import { DEFAULT_ISSUERS } from './verify.js'

/**
 * The Ideate MCP server.
 *
 * Gives an agent the document that is **open in the browser right now** — not a
 * file on disk. Edits land in CodeMirror as real transactions, so the live
 * preview, the dirty gutter and the undo history all behave exactly as they do
 * for a human edit, and the result comes back with the renderer's own verdict on
 * it. That feedback loop is the reason this exists: an agent editing files finds
 * out its diagram is broken when a human opens it; an agent editing through here
 * finds out in the result of its own tool call.
 *
 * Attaching is a deliberate step. The server holds a waiting tab but refuses to
 * read or change anything until `ideate_connect` is called, because this process
 * starts with an agent session rather than by anyone's decision — silently adopting
 * whichever tab was open would mean editing a human's document with nobody having
 * chosen it. `ideate_status` works unattached, so an agent can say what it is about
 * to attach to before it does.
 *
 * Nothing is ever committed. Saving stays a human action in the UI, so an agent
 * driving this cannot write to the user's repository — the blast radius is the
 * uncommitted working copy, which is on screen and one ⌘Z away.
 */

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function list(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name]?.trim()
  if (!raw) return [...fallback]
  return raw
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

const issuers = list('IDEATE_TRUSTED_ISSUERS', DEFAULT_ISSUERS)
const extraOrigins = list('IDEATE_BRIDGE_ORIGIN', [])

/* ------------------------------------------------------------------ */
/* Bridge                                                             */
/* ------------------------------------------------------------------ */

/**
 * Bind the first free port in `BRIDGE_PORTS`.
 *
 * The range is a shared constant rather than an environment variable so the tab
 * dials exactly the ports this can occupy — an env override could bind somewhere
 * the tab never looks, which presents as "the agent can't see my editor" with
 * nothing to point at. A second agent session simply takes the next port; the tab
 * walks the range and finds whichever is listening.
 */
async function listen(): Promise<Bridge> {
  let lastError: unknown
  for (const port of BRIDGE_PORTS) {
    const bridge = new Bridge({ port, issuers, extraOrigins })
    try {
      await bridge.start()
      process.stderr.write(
        `[ideate-mcp] listening on ws://127.0.0.1:${port} — trusted issuers: ${issuers.join(', ')}\n`,
      )
      return bridge
    } catch (error) {
      lastError = error
      bridge.close()
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not bind any bridge port (tried ${BRIDGE_PORTS.join(', ')}).`)
}

const bridge = await listen()

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

const server = new McpServer({ name: 'ideate', version: '0.1.0' })

/** Send one command to the tab and render its answer.
 *
 *  Failures come back as `isError` text rather than a thrown exception, because
 *  every one of them is something the agent can act on — a missing anchor, a wrong
 *  path, a scene tool aimed at markdown. An exception would reach the model as a
 *  protocol error with the useful part stripped off. */
async function forward(command: Command): Promise<CallToolResult> {
  try {
    const data = await bridge.call(command)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

server.registerTool(
  'ideate_connect',
  {
    title: 'Ideate: connect',
    description:
      'Attach to the Ideate tab waiting on this machine. Required before any tool can ' +
      'read or change the document — attaching to a human’s open editor is a deliberate ' +
      'step, not something that happens because this server started. Returns what you ' +
      'attached to (repository, branch, open file, kind), and the app shows the human ' +
      'that an agent is now connected. Call ideate_status first if you want to check ' +
      'what is open before committing to it.',
    inputSchema: {
      agent: z
        .string()
        .optional()
        .describe(
          'Who is attaching, e.g. "Claude Code". Shown to the human in the app so the ' +
            'connection is not anonymous.',
        ),
    },
  },
  ({ agent }) => {
    try {
      const state = bridge.attach(agent ?? null)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ attached: true, tab: state }, null, 2),
          },
        ],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text', text: message }], isError: true }
    }
  },
)

server.registerTool(
  'ideate_disconnect',
  {
    title: 'Ideate: disconnect',
    description:
      'Let go of the tab. The link stays switched on in the browser, so a later ' +
      'ideate_connect needs no action from the human. Worth calling when you are done, ' +
      'so the app stops telling them an agent can edit their document.',
    inputSchema: {},
  },
  () => {
    bridge.detach()
    return { content: [{ type: 'text', text: JSON.stringify({ attached: false }, null, 2) }] }
  },
)

server.registerTool(
  'ideate_status',
  {
    title: 'Ideate: status',
    description:
      'What is open in the Ideate editor right now: mode (github/local), repository and ' +
      'branch, the open file path, its kind (mermaid / markdown / excalidraw), whether it ' +
      'has uncommitted changes, its size, and the cursor position. Call this first — the ' +
      'kind decides whether to use the text tools or the scene tools. Works before ' +
      'ideate_connect, so you can report what is open before attaching to it.',
    inputSchema: {},
  },
  async () => {
    // The one tool allowed through unattached: it returns metadata about which
    // document is open, never its content, and it is what an agent needs in order
    // to describe what attaching would give it.
    if (!bridge.attached()) {
      if (!bridge.waiting()) {
        return {
          content: [
            {
              type: 'text',
              text:
                'No Ideate tab is waiting. Open the Ideate editor in a browser and click ' +
                '"Connect Agent" in the toolbar to switch on Agent Link.',
            },
          ],
          isError: true,
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                attached: false,
                hint: 'A tab is waiting. Call ideate_connect to attach before reading or editing.',
                tab: bridge.state(),
              },
              null,
              2,
            ),
          },
        ],
      }
    }
    return forward({ cmd: 'status' })
  },
)

server.registerTool(
  'ideate_list_files',
  {
    title: 'Ideate: list files',
    description:
      'Every diagram, document and canvas file in the connected repository, on the ' +
      'branch currently selected. Empty in local mode (no repository).',
    inputSchema: {},
  },
  () => forward({ cmd: 'list_files' }),
)

server.registerTool(
  'ideate_read',
  {
    title: 'Ideate: read',
    description:
      'Read a document. With no path, returns the working copy of the open document — ' +
      'including uncommitted edits, which is what the human is looking at. With a path, ' +
      'returns that file as committed on the current branch.',
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe('Repo-relative path. Omit to read the open document.'),
    },
  },
  ({ path }) => forward({ cmd: 'read', ...(path === undefined ? {} : { path }) }),
)

server.registerTool(
  'ideate_edit',
  {
    title: 'Ideate: edit',
    description:
      'Edit the open document by replacing exact strings. Every edit is applied as one ' +
      'undo step in the live editor, so the human sees the change appear and can take the ' +
      'whole batch back with one ⌘Z. The result carries the renderer’s diagnostics, so a ' +
      'broken diagram can be fixed in the same turn without a separate check. ' +
      'Nothing is committed — this changes the working copy only. ' +
      'Anchors must match the document as it is now: if any one is missing or ambiguous, ' +
      'nothing is applied and the error says which.',
    inputSchema: {
      edits: z
        .array(
          z.object({
            oldText: z.string().describe('Exact text to replace. Must appear in the document.'),
            newText: z.string().describe('Replacement text. Empty string deletes.'),
            replaceAll: z
              .boolean()
              .optional()
              .describe(
                'Replace every occurrence. Required when oldText appears more than once — ' +
                  'otherwise ambiguity is an error rather than a guess.',
              ),
          }),
        )
        .min(1)
        .describe(
          'Applied together against the document as it is now, not against the result of ' +
            'earlier edits in the same call.',
        ),
    },
  },
  ({ edits }) => forward({ cmd: 'edit', edits }),
)

server.registerTool(
  'ideate_write',
  {
    title: 'Ideate: write',
    description:
      'Replace the whole open document. Prefer ideate_edit for anything smaller than a ' +
      'rewrite — a full replacement discards the human’s cursor position and makes the ' +
      'change unreadable in the diff. Returns the renderer’s diagnostics. Not committed.',
    inputSchema: {
      text: z.string().describe('The complete new content of the document.'),
    },
  },
  ({ text }) => forward({ cmd: 'write', text }),
)

server.registerTool(
  'ideate_open',
  {
    title: 'Ideate: open file',
    description:
      'Open a file from the connected repository in the editor, so it becomes the document ' +
      'the other tools act on. Uncommitted edits to the current document are kept (they ' +
      'live in the browser’s local draft storage) — nothing is lost by switching.',
    inputSchema: {
      path: z.string().describe('Repo-relative path, as listed by ideate_list_files.'),
    },
  },
  ({ path }) => forward({ cmd: 'open', path }),
)

server.registerTool(
  'ideate_create_file',
  {
    title: 'Ideate: create file',
    description:
      'Create a new file and open it. It exists only in the browser as an uncommitted ' +
      'document until the human saves it — nothing is pushed to GitHub. The extension ' +
      'decides the editor: .mmd/.mermaid for a diagram, .md/.markdown for a document, ' +
      '.excalidraw for a canvas.',
    inputSchema: {
      path: z.string().describe('Repo-relative path including the extension.'),
      content: z
        .string()
        .optional()
        .describe('Initial content. Omit for a starter template appropriate to the kind.'),
    },
  },
  ({ path, content }) =>
    forward({ cmd: 'create_file', path, ...(content === undefined ? {} : { content }) }),
)

server.registerTool(
  'ideate_check',
  {
    title: 'Ideate: check',
    description:
      'Ask the renderer what it thinks of the open document, without changing it: mermaid ' +
      'parse errors for a diagram, or for every ```mermaid fence in a markdown document. ' +
      'ideate_edit already returns this, so reach for it only to check something you did ' +
      'not just write.',
    inputSchema: {},
  },
  () => forward({ cmd: 'check' }),
)

server.registerTool(
  'ideate_scene_get',
  {
    title: 'Ideate: read canvas',
    description:
      'What is on the open Excalidraw canvas: one line per element with its id, type, ' +
      'position, size and text. Ids are what ideate_scene_edit addresses. The full scene ' +
      'JSON is available but large and mostly bookkeeping — the summary is nearly always ' +
      'what you want.',
    inputSchema: {
      full: z
        .boolean()
        .optional()
        .describe('Also return the entire scene file. Large; rarely needed.'),
    },
  },
  ({ full }) => forward({ cmd: 'scene_get', ...(full === undefined ? {} : { full }) }),
)

const sceneAddOp = z.object({
  op: z.literal('add'),
  id: z
    .string()
    .optional()
    .describe(
      'Your own id for this element, so arrows in the same call can bind to it and a ' +
        'later call can update it. Generated when omitted.',
    ),
  type: z.enum(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line']),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  text: z
    .string()
    .optional()
    .describe('The content of a text element, or a label centred inside a shape.'),
  strokeColor: z.string().optional().describe('CSS color, e.g. "#1e1e1e".'),
  backgroundColor: z.string().optional().describe('Fill color, or "transparent".'),
  fillStyle: z.enum(['hachure', 'cross-hatch', 'solid']).optional(),
  strokeWidth: z.number().optional(),
  roughness: z.number().optional().describe('0 = architect, 1 = artist, 2 = cartoonist.'),
  start: z
    .string()
    .optional()
    .describe(
      'For an arrow or line: the id of the element it starts at — either something ' +
        'already on the canvas or something created in this same call. The arrow is ' +
        'routed between the two shapes for you; x and y are ignored when both ends bind.',
    ),
  end: z.string().optional().describe('The id of the element the arrow or line ends at.'),
  points: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .optional()
    .describe('Explicit geometry for an unbound arrow or line, relative to x/y.'),
})

const sceneUpdateOp = z.object({
  op: z.literal('update'),
  id: z.string().describe('Element id, from ideate_scene_get.'),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  text: z.string().optional().describe('Rewrites the element’s text, or its bound label.'),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
})

const sceneDeleteOp = z.object({
  op: z.literal('delete'),
  id: z.string().describe('Element id. A shape’s label is removed with it.'),
})

server.registerTool(
  'ideate_scene_edit',
  {
    title: 'Ideate: edit canvas',
    description:
      'Add, move, restyle or remove elements on the open Excalidraw canvas. The change ' +
      'appears on the canvas immediately and is not committed. Adds are processed first, ' +
      'as one batch, so an arrow can join two shapes created in the same call, and an ' +
      'update can target something the call just added.',
    inputSchema: {
      ops: z
        .array(z.union([sceneAddOp, sceneUpdateOp, sceneDeleteOp]))
        .min(1)
        .describe('Applied in order, with all adds first.'),
    },
  },
  ({ ops }) => forward({ cmd: 'scene_edit', ops }),
)

/* ------------------------------------------------------------------ */

// Close the bridge on the way out so the port is free for the next session —
// otherwise a restarted agent hits EADDRINUSE against its own corpse.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    bridge.close()
    process.exit(0)
  })
}

await server.connect(new StdioServerTransport())
