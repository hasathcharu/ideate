import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform'
import type {
  SceneAddOp,
  SceneAlignOp,
  SceneDistributeOp,
  SceneElementSummary,
  SceneGetResult,
  SceneOp,
  SceneUpdateOp,
  SceneWarning,
} from './agentProtocol'
import { EMPTY_SCENE, parseScene } from './excalidraw'
import { ensureExcalidrawFonts } from './excalidrawFonts'
import { lintScene } from './sceneLint'

/** Element-level edits to an Excalidraw scene, for Agent Link. */

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
  /** What `lib/sceneLint.ts` makes of the result. Returned from here rather than
   *  recomputed by the caller because this is where the finished element array
   *  exists — the caller holds only the serialized text. */
  warnings: SceneWarning[]
}

/**
 * Apply `ops` to `sceneText`. **Adds are processed as one batch, before any update or delete.**
 * That is what lets an arrow bind to shapes created in the same call: binding is done by
 * Excalidraw's own skeleton converter, which resolves ids only within the batch it is given and is
 * also what computes the attachment geometry.
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

  // Before anything is measured. Every box that holds text is sized from a canvas
  // `measureText` against Excalidraw's own font, so an unloaded font is a wrong
  // answer rather than a missing one — see `awaitTextFonts`.
  const fonts = await awaitTextFonts(ops.map((op) => ('text' in op ? op.text : undefined)))

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

  // Ids whose geometry this call changed, collected rather than acted on: the arrows bound to them
  // are re-routed once, at the end.
  const moved = new Set<string>()

  for (const op of rest) {
    switch (op.op) {
      case 'update':
        elements = await applyUpdate(elements, op)
        if (op.x !== undefined || op.y !== undefined) moved.add(op.id)
        // A resize moves the element's edges without moving the element, which is
        // the same thing as far as an arrow bound to it is concerned. A text
        // rewrite counts for the same reason: `refit` re-measures the label and
        // grows the box around it.
        if (op.width !== undefined || op.height !== undefined || op.text !== undefined) {
          moved.add(op.id)
        }
        break
      case 'delete':
        elements = applyDelete(elements, op.id)
        break
      case 'align':
        elements = applyAlign(elements, op)
        for (const id of op.ids) moved.add(id)
        break
      case 'distribute':
        elements = applyDistribute(elements, op)
        for (const id of op.ids) moved.add(id)
        break
    }
  }

  elements = rerouteBoundArrows(elements, moved)

  return {
    text: JSON.stringify({ ...scene, elements }, null, 2),
    elementCount: elements.length,
    // The whole scene, not just what this call touched: a new box overlapping an old one is a
    // finding about both, and the caller is the only party that can move either.
    warnings: [...fontWarning(fonts, ops), ...lintScene(elements)],
  }
}

/** The `font_unavailable` finding, or nothing when the fonts were there or no op in
 *  this call carried text for them to matter to. */
function fontWarning(loaded: boolean, ops: readonly SceneOp[]): SceneWarning[] {
  if (loaded) return []
  if (!ops.some((op) => 'text' in op && op.text)) return []
  return [
    {
      kind: 'font_unavailable',
      ids: [],
      message:
        'Excalidraw\'s fonts could not be loaded, so the labels in this call were measured ' +
        'against a substitute face and every box sized here may be narrower than the text ' +
        'it holds. Nothing is wrong with the ops — this is the app failing to fetch its own ' +
        'font assets. Set an explicit `width` on the shapes that hold text if the drawing ' +
        'has to be right regardless, and tell the human: it will affect their own typing ' +
        'on the canvas too.',
    },
  ]
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
    // Geometry is computed here rather than left to Excalidraw's converter.
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
 * Where an arrow between two shapes should start and end: centre to centre, pulled back to each
 * shape's edge and then by `BINDING_GAP`.
 */
function route(
  op: SceneAddOp,
  boxes: ReadonlyMap<string, Box>,
): { x: number; y: number; points: number[][] } {
  const from = endpointBox(op.start, 'start', boxes)
  const to = endpointBox(op.end, 'end', boxes)

  // One end unbound: keep the caller's own coordinate for it.
  return routeBetween(from, to, { x: op.x, y: op.y }, {
    x: op.x + (op.width ?? 100),
    y: op.y + (op.height ?? 0),
  })
}

/** The geometry itself, in the absolute frame, for an arrow joining `from` to `to`. */
function routeBetween(
  from: Box | null,
  to: Box | null,
  fallbackStart: { x: number; y: number },
  fallbackEnd: { x: number; y: number },
): { x: number; y: number; points: number[][] } {
  const a = from ? centre(from) : fallbackStart
  const b = to ? centre(to) : fallbackEnd

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

/** Wire each new arrow to the elements it names, in both directions. */
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

/** Excalidraw's default font, and the fallback its font string names after it. */
const MEASURED_FONT_FAMILIES = ['Excalifont', 'Xiaolai'] as const

/** The size every label is measured at: Excalidraw's `DEFAULT_FONT_SIZE`, which
 *  is what a bound label gets when the skeleton names no size. Font *matching*
 *  ignores it, but `document.fonts.load` wants a complete font shorthand. */
const MEASURED_FONT_SIZE = 20

/** Load the fonts the sizing pass is about to measure with, and don't measure until they are in. */
async function awaitTextFonts(texts: readonly (string | undefined)[]): Promise<boolean> {
  if (typeof document === 'undefined' || !document.fonts) return false
  const characters = texts.filter((text): text is string => !!text).join('')
  // No text to measure, so nothing to be wrong about.
  if (!characters) return true

  // The characters decide which tiers are needed — the CJK fallback is a separate
  // fetch, and most labels never ask for it.
  if (!(await ensureExcalidrawFonts(characters))) return false

  await Promise.all(
    MEASURED_FONT_FAMILIES.map(async (family) => {
      try {
        // Excalidraw ships each face as per-glyph-range subsets, so the text has to
        // be passed: `load` fetches only the subsets these characters need.
        await document.fonts.load(`${MEASURED_FONT_SIZE}px ${family}`, characters)
      } catch {
        // An unregistered family resolves empty; only a malformed shorthand throws,
        // and a failed load is not a reason to abandon the edit.
      }
    }),
  )

  // `check` asks the question the measurement is about to ask — is there a *loaded* face for these
  // characters — rather than whether the load resolved, which catches a subset that failed to
  // fetch.
  return document.fonts.check(`${MEASURED_FONT_SIZE}px ${MEASURED_FONT_FAMILIES[0]}`, characters)
}

async function applyUpdate(
  elements: ExcalidrawElement[],
  op: SceneUpdateOp,
): Promise<ExcalidrawElement[]> {
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

  // Worked out before anything is written, because it is a *delta*: the label that
  // has to come along carries its own absolute coordinates, and once the container
  // has been moved there is nothing left to subtract from.
  const dx = op.x === undefined ? 0 : op.x - target.x
  const dy = op.y === undefined ? 0 : op.y - target.y

  const updated = elements.map((element) => {
    if (element.id === labelId) {
      // Text only — the geometry is settled by `refit` below, which measures it
      // the same way the add path does rather than guessing at a width here.
      return { ...element, text: op.text, originalText: op.text } as ExcalidrawElement
    }
    if (element.id !== op.id) return element

    // x/y are deliberately absent here — the move goes through `translate` below,
    // which is the one path that also brings the bound label.
    const next: Record<string, unknown> = { ...element }
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

  // Text, and the box around it, are one measurement — so anything that changes either side of it
  // re-runs that measurement.
  const moved = dx !== 0 || dy !== 0 ? translate(updated, new Map([[op.id, { dx, dy }]])) : updated

  const resized = op.text !== undefined || op.width !== undefined || op.height !== undefined
  // After the move, not before: `refit` re-places the label from the container's
  // coordinates, so it has to see the ones the element ended up with.
  return resized ? refit(moved, op.id) : moved
}

/** Element types Excalidraw's skeleton converter can bind a label inside. A
 *  `line` is deliberately absent — the converter's label branch does not handle
 *  one, so a line's text is a separate element, not a bound label. */
const LABELABLE_TYPES = ['rectangle', 'ellipse', 'diamond', 'arrow'] as const

/**
 * Re-measure `id`'s text and re-fit its box, by running the same skeleton conversion the add path
 * uses.
 */
async function refit(
  elements: ExcalidrawElement[],
  id: string,
): Promise<ExcalidrawElement[]> {
  const container = elements.find((element) => element.id === id)
  if (!container) return elements

  // A standalone text element is its own measurement: no wrapping, no box.
  if (container.type === 'text') {
    const measured = await measureSkeleton({
      type: 'text',
      x: container.x,
      y: container.y,
      text: container.text,
      fontSize: container.fontSize,
      fontFamily: container.fontFamily,
    })
    if (!measured) return elements
    return elements.map((element) =>
      element.id === id
        ? ({ ...element, width: measured[0]!.width, height: measured[0]!.height } as ExcalidrawElement)
        : element,
    )
  }

  // The only shapes that can hold a bound label. Anything else has nothing to
  // re-measure, and the skeleton API would not accept it.
  if (!LABELABLE_TYPES.includes(container.type as (typeof LABELABLE_TYPES)[number])) {
    return elements
  }

  const labelId = (container.boundElements ?? []).find((bound) => bound.type === 'text')?.id
  const label = elements.find((element) => element.id === labelId)
  if (!label || label.type !== 'text') return elements

  const measured = await measureSkeleton({
    type: container.type as (typeof LABELABLE_TYPES)[number],
    x: container.x,
    y: container.y,
    width: container.width,
    height: container.height,
    // An arrow wraps its label against its own length and positions it along its
    // path, so the points have to travel with it.
    ...(container.type === 'arrow'
      ? { points: (container as { points: readonly (readonly number[])[] }).points }
      : {}),
    label: {
      text: label.originalText || label.text,
      fontSize: label.fontSize,
      fontFamily: label.fontFamily,
      textAlign: label.textAlign,
      verticalAlign: label.verticalAlign,
    },
  } as ExcalidrawElementSkeleton)
  if (!measured) return elements

  const fitContainer = measured.find((element) => element.type !== 'text')
  const fitLabel = measured.find((element) => element.type === 'text')
  if (!fitContainer || !fitLabel || fitLabel.type !== 'text') return elements

  // An arrow is sized by its points, not the other way round: Excalidraw widens a *shape* to fit
  // its label but leaves an arrow alone, and writing the measured width onto one would desync
  // `width` from `points`.
  const isArrow = container.type === 'arrow'

  return elements.map((element) => {
    if (element.id === id) {
      if (isArrow) return element
      // Width and height only. The converter reproduces the container from a
      // skeleton, so every other field on it is a default, not this element's.
      return { ...element, width: fitContainer.width, height: fitContainer.height } as ExcalidrawElement
    }
    if (element.id === labelId) {
      return {
        ...element,
        // `text` is the wrapped form and `originalText` the source; keeping the
        // two straight is what lets a later edit re-wrap from the real text.
        text: fitLabel.text,
        originalText: fitLabel.originalText,
        width: fitLabel.width,
        height: fitLabel.height,
        ...(isArrow ? {} : { x: fitLabel.x, y: fitLabel.y }),
      } as ExcalidrawElement
    }
    return element
  })
}

/** One skeleton through the converter, for its measurements. Returns null if the
 *  conversion produced nothing usable — the caller then leaves the element as it
 *  found it rather than writing a guess over it. */
async function measureSkeleton(
  skeleton: ExcalidrawElementSkeleton,
): Promise<ExcalidrawElement[] | null> {
  const { convertToExcalidrawElements } = await import('@excalidraw/excalidraw')
  const created = convertToExcalidrawElements([skeleton])
  return created.length > 0 ? [...created] : null
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

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

/**
 * `align` and `distribute` exist because the caller cannot do this arithmetic safely from where it
 * stands.
 */
function applyAlign(elements: ExcalidrawElement[], op: SceneAlignOp): ExcalidrawElement[] {
  const targets = layoutTargets(elements, op.ids, 'align')

  const left = Math.min(...targets.map((element) => element.x))
  const right = Math.max(...targets.map((element) => element.x + element.width))
  const top = Math.min(...targets.map((element) => element.y))
  const bottom = Math.max(...targets.map((element) => element.y + element.height))

  const moves = new Map<string, { x?: number; y?: number }>()
  for (const element of targets) {
    switch (op.axis) {
      case 'left':
        moves.set(element.id, { x: left })
        break
      case 'right':
        moves.set(element.id, { x: right - element.width })
        break
      case 'top':
        moves.set(element.id, { y: top })
        break
      case 'bottom':
        moves.set(element.id, { y: bottom - element.height })
        break
      // Centred on the bounding box of the selection, not on each other, so the
      // answer does not depend on which element happens to be listed first.
      case 'centerX':
        moves.set(element.id, { x: (left + right) / 2 - element.width / 2 })
        break
      case 'centerY':
        moves.set(element.id, { y: (top + bottom) / 2 - element.height / 2 })
        break
    }
  }
  return moveElements(elements, moves)
}

/**
 * Space elements evenly along one axis. Ordered by where the elements already are rather than by
 * the order the ids were written in: the caller is describing a row that exists, and re-ordering
 * one by accident — because it listed the ids as it found them in a `scene_get` — would be a much
 * bigger edit than it asked for.
 */
function applyDistribute(
  elements: ExcalidrawElement[],
  op: SceneDistributeOp,
): ExcalidrawElement[] {
  const horizontal = op.axis === 'x'
  const start = (element: ExcalidrawElement) => (horizontal ? element.x : element.y)
  const extent = (element: ExcalidrawElement) => (horizontal ? element.width : element.height)

  const targets = layoutTargets(elements, op.ids, 'distribute').sort(
    (one, two) => start(one) - start(two),
  )

  let gap = op.gap
  if (gap === undefined) {
    if (targets.length < 3) {
      throw new Error(
        'Distributing two elements has nothing to equalize — the outer two are the ' +
          'ones that do not move. Pass `gap` to set the spacing, or list three ids or more.',
      )
    }
    const first = targets[0]!
    const last = targets[targets.length - 1]!
    const span = start(last) + extent(last) - start(first)
    const occupied = targets.reduce((total, element) => total + extent(element), 0)
    gap = (span - occupied) / (targets.length - 1)
  } else if (gap < 0) {
    throw new Error(
      `gap is ${gap}. A negative gap overlaps every pair in the row, which is a ` +
        'drawing you can make with `update` ops but not one to ask for by name.',
    )
  }

  const moves = new Map<string, { x?: number; y?: number }>()
  // The first element anchors the row and stays exactly where it is.
  let cursor = start(targets[0]!) + extent(targets[0]!) + gap
  for (const element of targets.slice(1)) {
    // Whole pixels: an equalized gap divides a span that rarely divides evenly, and
    // fractional coordinates are what `misaligned` is looking for in the first place.
    const value = Math.round(cursor)
    moves.set(element.id, horizontal ? { x: value } : { y: value })
    cursor = value + extent(element) + gap
  }
  return moveElements(elements, moves)
}

/** Resolve the ids a layout op names, refusing the cases where doing the arithmetic
 *  anyway would produce a drawing nobody asked for. */
function layoutTargets(
  elements: readonly ExcalidrawElement[],
  ids: readonly string[],
  op: 'align' | 'distribute',
): ExcalidrawElement[] {
  if (ids.length < 2) {
    throw new Error(
      `${op} needs at least two ids — one element is already ` +
        `${op === 'align' ? 'aligned' : 'spaced'} with itself.`,
    )
  }
  const seen = new Set<string>()
  return ids.map((id) => {
    if (seen.has(id)) throw new Error(`${op} lists "${id}" twice.`)
    seen.add(id)

    const element = elements.find((candidate) => candidate.id === id)
    if (!element) {
      throw new Error(`No element with id "${id}". Call scene_get to list what is there.`)
    }
    // A bound label has no position of its own to line up — it is placed by the
    // shape it sits inside, and the next thing that re-measures that shape puts it
    // back. `scene_get` does not report labels as elements, so an id that turns out
    // to be one came from `full` output and is very likely a mistake.
    if ((element as { containerId?: string | null }).containerId) {
      throw new Error(
        `"${id}" is a label bound inside another element, so it moves with its ` +
          'container rather than on its own. Pass the container\'s id instead.',
      )
    }
    return element
  })
}

/** Put elements at new coordinates, given absolutely. Reduced to deltas here
 *  because that is what a bound label needs; see `translate`. */
function moveElements(
  elements: ExcalidrawElement[],
  targets: ReadonlyMap<string, { x?: number; y?: number }>,
): ExcalidrawElement[] {
  const deltas = new Map<string, { dx: number; dy: number }>()
  for (const element of elements) {
    const to = targets.get(element.id)
    if (!to) continue
    const dx = to.x === undefined ? 0 : to.x - element.x
    const dy = to.y === undefined ? 0 : to.y - element.y
    if (dx !== 0 || dy !== 0) deltas.set(element.id, { dx, dy })
  }
  return deltas.size === 0 ? elements : translate(elements, deltas)
}

/** Shift elements by their own delta, each one taking its bound label with it. */
function translate(
  elements: ExcalidrawElement[],
  deltas: ReadonlyMap<string, { dx: number; dy: number }>,
): ExcalidrawElement[] {
  return elements.map((element) => {
    const containerId = (element as { containerId?: string | null }).containerId
    const delta = deltas.get(element.id) ?? (containerId ? deltas.get(containerId) : undefined)
    if (!delta) return element
    return {
      ...element,
      x: element.x + delta.dx,
      y: element.y + delta.dy,
      version: (element.version ?? 1) + 1,
    } as ExcalidrawElement
  })
}

/** Redraw the arrows bound to anything this call moved or resized. */
function rerouteBoundArrows(
  elements: ExcalidrawElement[],
  moved: ReadonlySet<string>,
): ExcalidrawElement[] {
  if (moved.size === 0) return elements

  const boxes = new Map<string, Box>()
  for (const element of elements) boxes.set(element.id, boxOf(element))

  return elements.map((element) => {
    if (element.type !== 'arrow' && element.type !== 'line') return element

    const startId = bindingTarget(element, 'startBinding')
    const endId = bindingTarget(element, 'endBinding')
    if (!startId && !endId) return element
    if (!((startId && moved.has(startId)) || (endId && moved.has(endId)))) return element

    const points = (element as { points?: readonly (readonly number[])[] }).points
    // Two points, or leave it alone. A multi-point arrow carries a route somebody
    // chose — elbows, a detour around a box — and `routeBetween` only knows how to
    // draw a straight line, so "fixing" one would throw that away because a shape at
    // one end moved by twenty pixels.
    if (!points || points.length !== 2) return element

    const first = points[0]!
    const last = points[points.length - 1]!
    const geometry = routeBetween(
      // A binding to something this call deleted resolves to nothing, and the end
      // then keeps the coordinate it already had rather than collapsing to the origin.
      startId ? (boxes.get(startId) ?? null) : null,
      endId ? (boxes.get(endId) ?? null) : null,
      { x: element.x + (first[0] ?? 0), y: element.y + (first[1] ?? 0) },
      { x: element.x + (last[0] ?? 0), y: element.y + (last[1] ?? 0) },
    )

    return {
      ...element,
      x: geometry.x,
      y: geometry.y,
      points: geometry.points,
      version: (element.version ?? 1) + 1,
    } as ExcalidrawElement
  })
}

/** The element an arrow end is bound to, or null when that end is loose. */
function bindingTarget(
  element: ExcalidrawElement,
  key: 'startBinding' | 'endBinding',
): string | null {
  const binding = (element as Partial<Record<typeof key, { elementId?: unknown } | null>>)[key]
  const id = binding?.elementId
  return typeof id === 'string' && id !== '' ? id : null
}

function boxOf(element: ExcalidrawElement): Box {
  return { x: element.x, y: element.y, width: element.width, height: element.height }
}

/** One color off an element, or null when the file does not carry it. */
function colorOf(element: ExcalidrawElement, key: 'strokeColor' | 'backgroundColor'): string | null {
  const value = (element as Partial<Record<typeof key, unknown>>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * What is on the canvas, compactly. The full scene JSON is enormous — mostly per-element
 * bookkeeping an agent has no use for — so the default answer is one line per element and the whole
 * file is opt-in.
 */
export function summarizeScene(
  sceneText: string,
  full = false,
): Omit<SceneGetResult, 'path' | 'revision'> {
  const scene = parseScene(sceneText)
  if (!scene) throw new Error('That document is not a readable Excalidraw scene.')

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
      // A scene *is* its colors — there is no theme layer over a canvas the way there is over a
      // mermaid diagram — so an agent adding to an existing drawing has to see them to match them.
      strokeColor: colorOf(element, 'strokeColor'),
      backgroundColor: colorOf(element, 'backgroundColor'),
    }))

  return {
    elementCount: scene.elements.length,
    elements,
    // Linted on read as well as on write, because "fix the layout of this canvas"
    // starts here: an agent working on a drawing it did not make needs the same
    // findings, and a human's own drawing produces them too.
    warnings: lintScene(scene.elements),
    ...(full ? { json: sceneText } : {}),
  }
}
