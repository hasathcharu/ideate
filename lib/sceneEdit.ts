import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform'
import type {
  SceneAddOp,
  SceneElementSummary,
  SceneGetResult,
  SceneOp,
  SceneUpdateOp,
} from './agentProtocol'
import { EMPTY_SCENE, parseScene } from './excalidraw'

/**
 * Element-level edits to an Excalidraw scene, for Agent Link.
 *
 * Native rather than relayed to one of the standalone Excalidraw MCP servers: a
 * `.excalidraw` file is JSON this app already holds, and every one of those
 * servers owns its own element store and its own canvas, so relaying would mean a
 * hydrate → forward → read-back round trip against state that has no business
 * existing here.
 *
 * **Rule 8 holds.** `@excalidraw/excalidraw` is reached only through a
 * per-function `await import` — the same door `lib/exportScene.ts` uses — and the
 * two imports at the top are types, which are erased. Nothing here may become a
 * module-scope value import, or every mermaid-only user starts paying for the ~1MB
 * editor bundle.
 *
 * The result is scene *text*, handed to `setText` like any other document edit.
 * That is deliberate: `CanvasInner` already ingests an external `value` through
 * `updateScene`, so dirty tracking (`scenesEqual`, rule 9) and the file's own
 * stored background (rule 10) keep working with nothing added.
 */

/** Style keys that pass straight through to the skeleton. */
interface Styling {
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: 'hachure' | 'cross-hatch' | 'solid'
  strokeWidth?: number
  roughness?: number
}

export interface SceneEditOutcome {
  text: string
  elementCount: number
}

/**
 * Apply `ops` to `sceneText`.
 *
 * **Adds are processed as one batch, before any update or delete.** That is what
 * lets an arrow bind to shapes created in the same call: binding is done by
 * Excalidraw's own skeleton converter, which resolves ids only within the batch it
 * is given and is also what computes the attachment geometry. It also means an
 * update in the same call can target something the call just added.
 */
export async function applySceneOps(
  sceneText: string,
  ops: readonly SceneOp[],
): Promise<SceneEditOutcome> {
  if (ops.length === 0) throw new Error('No scene ops given.')

  // A brand-new `.excalidraw` file can legitimately be empty (the template is
  // written only when the editor opens it), so fall back to a blank scene rather
  // than refusing to draw on it.
  const scene = parseScene(sceneText) ?? parseScene(EMPTY_SCENE)
  if (!scene) throw new Error('The open document is not a readable Excalidraw scene.')

  const adds = ops.filter((op): op is SceneAddOp => op.op === 'add')
  const rest = ops.filter((op) => op.op !== 'add')

  let elements: ExcalidrawElement[] = [...scene.elements]

  if (adds.length > 0) {
    // Every box an arrow could attach to: what is already on the canvas, plus
    // what this batch is about to add. Both, so "arrow from the box I just made to
    // the box that was already there" works — the geometry below only needs the
    // two rectangles, and it does not care which list they came from.
    const boxes = new Map<string, Box>()
    for (const element of elements) {
      boxes.set(element.id, {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      })
    }
    // Ids are assigned up front so an arrow can name a sibling in the same batch
    // regardless of the order the ops were written in.
    const ids = adds.map((op) => op.id ?? generateId())
    adds.forEach((op, index) => {
      if (op.type === 'arrow' || op.type === 'line') return
      boxes.set(ids[index]!, {
        x: op.x,
        y: op.y,
        width: op.width ?? DEFAULT_SHAPE_WIDTH,
        height: op.height ?? DEFAULT_SHAPE_HEIGHT,
      })
    })

    const skeletons = adds.map((op, index) => toSkeleton(op, ids[index]!, boxes))
    const { convertToExcalidrawElements } = await import('@excalidraw/excalidraw')
    // `regenerateIds: false` so a caller-chosen id survives and a follow-up call
    // can address the element it just created.
    const created = convertToExcalidrawElements(skeletons, { regenerateIds: false })
    elements = bindArrows([...elements, ...created], adds, ids)
  }

  for (const op of rest) {
    if (op.op === 'update') elements = applyUpdate(elements, op)
    else elements = applyDelete(elements, op.id)
  }

  return {
    text: JSON.stringify({ ...scene, elements }, null, 2),
    elementCount: elements.length,
  }
}

function toSkeleton(
  op: SceneAddOp,
  id: string,
  boxes: ReadonlyMap<string, Box>,
): ExcalidrawElementSkeleton {
  const style: Styling = {}
  if (op.strokeColor !== undefined) style.strokeColor = op.strokeColor
  if (op.backgroundColor !== undefined) style.backgroundColor = op.backgroundColor
  if (op.fillStyle !== undefined) style.fillStyle = op.fillStyle
  if (op.strokeWidth !== undefined) style.strokeWidth = op.strokeWidth
  if (op.roughness !== undefined) style.roughness = op.roughness

  const base = { id, x: op.x, y: op.y, ...style }

  if (op.type === 'text') {
    if (!op.text) throw new Error('A text element needs `text`.')
    return { ...base, type: 'text', text: op.text } as ExcalidrawElementSkeleton
  }

  if (op.type === 'arrow' || op.type === 'line') {
    // Geometry is computed here rather than left to Excalidraw's converter. The
    // converter sets `startBinding`/`endBinding` but does not *route* the arrow —
    // it refines an arrow you already drew. Handed start/end with no points it
    // emits a 99px stub at the canvas origin: correctly bound, and invisible
    // nowhere near the shapes it joins.
    const geometry = op.start !== undefined || op.end !== undefined
      ? route(op, boxes)
      : {
          x: op.x,
          y: op.y,
          points: (op.points ?? [{ x: 0, y: 0 }, { x: op.width ?? 100, y: op.height ?? 0 }]).map(
            ({ x, y }) => [x, y],
          ),
        }
    return {
      ...base,
      type: op.type,
      x: geometry.x,
      y: geometry.y,
      points: geometry.points,
      ...(op.text ? { label: { text: op.text } } : {}),
      // Bindings are wired by `bindArrows` after conversion, not passed here: the
      // converter only resolves ids inside its own batch, and doing it ourselves
      // means an arrow can attach to something already on the canvas too.
    } as unknown as ExcalidrawElementSkeleton
  }

  // rectangle / ellipse / diamond. `label` is how the skeleton API asks for text
  // bound *inside* a shape — writing a separate text element and wiring
  // `containerId`/`boundElements` by hand is the same thing done worse.
  return {
    ...base,
    type: op.type,
    width: op.width ?? DEFAULT_SHAPE_WIDTH,
    height: op.height ?? DEFAULT_SHAPE_HEIGHT,
    ...(op.text ? { label: { text: op.text } } : {}),
  } as ExcalidrawElementSkeleton
}

/** A shape an arrow can attach to. */
interface Box {
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_SHAPE_WIDTH = 200
const DEFAULT_SHAPE_HEIGHT = 100

/** Space left between an arrowhead and the shape it points at. Matches the gap
 *  Excalidraw itself leaves when a human drags an arrow onto a shape. */
const BINDING_GAP = 8

/**
 * Where an arrow between two shapes should start and end: centre to centre,
 * pulled back to each shape's edge and then by `BINDING_GAP`.
 *
 * The box edge is used for ellipses and diamonds too. It is not exact for either,
 * but Excalidraw re-derives the visible attachment point from `focus`/`gap` when
 * it renders a bound arrow, so a close start is all this has to supply.
 */
function route(
  op: SceneAddOp,
  boxes: ReadonlyMap<string, Box>,
): { x: number; y: number; points: number[][] } {
  const from = endpointBox(op.start, 'start', boxes)
  const to = endpointBox(op.end, 'end', boxes)

  // One end unbound: keep the caller's own coordinate for it.
  const a = from ? centre(from) : { x: op.x, y: op.y }
  const b = to ? centre(to) : { x: op.x + (op.width ?? 100), y: op.y + (op.height ?? 0) }

  const start = from ? trim(a, b, from) : a
  const end = to ? trim(b, a, to) : b

  return {
    x: start.x,
    y: start.y,
    points: [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ],
  }
}

function endpointBox(
  id: string | undefined,
  which: 'start' | 'end',
  boxes: ReadonlyMap<string, Box>,
): Box | null {
  if (id === undefined) return null
  const box = boxes.get(id)
  if (!box) {
    throw new Error(
      `Arrow ${which} references "${id}", which is neither on the canvas nor created in ` +
        'this call. Call scene_get to list the element ids.',
    )
  }
  return box
}

function centre(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** `from`'s centre pushed out toward `toward` until it clears `box` plus the gap. */
function trim(
  from: { x: number; y: number },
  toward: { x: number; y: number },
  box: Box,
): { x: number; y: number } {
  const dx = toward.x - from.x
  const dy = toward.y - from.y
  const length = Math.hypot(dx, dy)
  // Concentric shapes have no direction to leave along; leave the point be rather
  // than dividing by zero.
  if (length === 0) return from
  // How far along the ray the box's own edge sits. Whichever axis runs out first
  // is the side the ray exits through.
  const scale = Math.min(
    dx === 0 ? Infinity : Math.abs(box.width / 2 / dx),
    dy === 0 ? Infinity : Math.abs(box.height / 2 / dy),
  )
  const out = scale + BINDING_GAP / length
  return { x: from.x + dx * out, y: from.y + dy * out }
}

/**
 * Wire each new arrow to the elements it names, in both directions.
 *
 * Excalidraw needs the pairing recorded twice — `startBinding`/`endBinding` on the
 * arrow, and an entry in each target's `boundElements` — or dragging the shape
 * leaves the arrow behind.
 */
function bindArrows(
  elements: ExcalidrawElement[],
  adds: readonly SceneAddOp[],
  ids: readonly string[],
): ExcalidrawElement[] {
  const bindings = new Map<string, { start?: string; end?: string }>()
  const inbound = new Map<string, string[]>()

  adds.forEach((op, index) => {
    if (op.type !== 'arrow' && op.type !== 'line') return
    if (op.start === undefined && op.end === undefined) return
    const arrowId = ids[index]!
    bindings.set(arrowId, { start: op.start, end: op.end })
    for (const target of [op.start, op.end]) {
      if (!target) continue
      inbound.set(target, [...(inbound.get(target) ?? []), arrowId])
    }
  })

  if (bindings.size === 0) return elements

  return elements.map((element) => {
    const binding = bindings.get(element.id)
    const arrows = inbound.get(element.id)
    if (!binding && !arrows) return element

    const next: Record<string, unknown> = { ...element }
    if (binding) {
      if (binding.start) next.startBinding = { elementId: binding.start, focus: 0, gap: BINDING_GAP }
      if (binding.end) next.endBinding = { elementId: binding.end, focus: 0, gap: BINDING_GAP }
    }
    if (arrows) {
      const existing = element.boundElements ?? []
      next.boundElements = [
        ...existing,
        ...arrows
          .filter((id) => !existing.some((entry) => entry.id === id))
          .map((id) => ({ id, type: 'arrow' as const })),
      ]
    }
    return next as ExcalidrawElement
  })
}

/** Excalidraw ids are 21-character nanoid-style strings; anything unique works,
 *  and this avoids importing the library just to make one. */
function generateId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let id = ''
  for (let i = 0; i < 21; i++) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return id
}

function applyUpdate(elements: ExcalidrawElement[], op: SceneUpdateOp): ExcalidrawElement[] {
  const target = elements.find((element) => element.id === op.id)
  if (!target) {
    throw new Error(`No element with id "${op.id}". Call scene_get to list what is there.`)
  }

  // A shape's label is its own text element pointing back at the container, so
  // "change the text" means changing a different element than the one addressed.
  const labelId =
    op.text !== undefined && target.type !== 'text'
      ? (target.boundElements ?? []).find((bound) => bound.type === 'text')?.id
      : undefined

  return elements.map((element) => {
    if (element.id === labelId) {
      // Dimensions are deliberately not recomputed here: text metrics need a
      // measured DOM, and Excalidraw's own restore pass re-measures bound text
      // when it ingests the scene. Guessing a width here would fight that.
      return { ...element, text: op.text, originalText: op.text } as ExcalidrawElement
    }
    if (element.id !== op.id) return element

    const next: Record<string, unknown> = { ...element }
    if (op.x !== undefined) next.x = op.x
    if (op.y !== undefined) next.y = op.y
    if (op.width !== undefined) next.width = op.width
    if (op.height !== undefined) next.height = op.height
    if (op.strokeColor !== undefined) next.strokeColor = op.strokeColor
    if (op.backgroundColor !== undefined) next.backgroundColor = op.backgroundColor
    if (op.text !== undefined && element.type === 'text') {
      next.text = op.text
      next.originalText = op.text
    }
    // Bumping `version` is how Excalidraw's reconciler knows this element is
    // newer than the one it holds. `sceneSignature` ignores the field, so this
    // cannot on its own make a file look dirty.
    next.version = (element.version ?? 1) + 1
    return next as ExcalidrawElement
  })
}

function applyDelete(elements: ExcalidrawElement[], id: string): ExcalidrawElement[] {
  const target = elements.find((element) => element.id === id)
  if (!target) {
    throw new Error(`No element with id "${id}". Call scene_get to list what is there.`)
  }

  // Deleting a shape has to take its bound label with it — an orphaned text
  // element with a dangling `containerId` renders adrift on the canvas.
  const doomed = new Set<string>([id])
  for (const element of elements) {
    if ((element as { containerId?: string | null }).containerId === id) doomed.add(element.id)
  }

  return elements
    .filter((element) => !doomed.has(element.id))
    .map((element) => {
      const bound = element.boundElements
      if (!bound?.some((entry) => doomed.has(entry.id))) return element
      // Leaving a reference to a removed element behind makes arrows try to bind
      // to nothing.
      return { ...element, boundElements: bound.filter((entry) => !doomed.has(entry.id)) }
    })
}

/**
 * What is on the canvas, compactly. The full scene JSON is enormous — mostly
 * per-element bookkeeping an agent has no use for — so the default answer is one
 * line per element and the whole file is opt-in.
 */
export function summarizeScene(sceneText: string, full = false): SceneGetResult {
  const scene = parseScene(sceneText)
  if (!scene) throw new Error('The open document is not a readable Excalidraw scene.')

  // A container's caption lives in a separate text element, so resolve it back
  // onto the shape it labels — otherwise every rectangle reads as untitled and
  // every label as a floating string.
  const labels = new Map<string, string>()
  for (const element of scene.elements) {
    const containerId = (element as { containerId?: string | null }).containerId
    const text = (element as { text?: string }).text
    if (containerId && typeof text === 'string') labels.set(containerId, text)
  }

  const elements: SceneElementSummary[] = scene.elements
    .filter((element) => !(element as { containerId?: string | null }).containerId)
    .map((element) => ({
      id: element.id,
      type: element.type,
      x: Math.round(element.x),
      y: Math.round(element.y),
      width: Math.round(element.width),
      height: Math.round(element.height),
      text: labels.get(element.id) ?? (element as { text?: string }).text ?? null,
    }))

  return {
    elementCount: scene.elements.length,
    elements,
    ...(full ? { json: sceneText } : {}),
  }
}
