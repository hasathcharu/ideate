import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform'
import type {
  SceneAddOp,
  SceneElementSummary,
  SceneGetResult,
  SceneOp,
  SceneUpdateOp,
  SceneWarning,
} from './agentProtocol'
import { EMPTY_SCENE, parseScene } from './excalidraw'
import { ensureExcalidrawFonts } from './excalidrawFonts'
import { lintScene } from './sceneLint'

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
  /** What `lib/sceneLint.ts` makes of the result. Returned from here rather than
   *  recomputed by the caller because this is where the finished element array
   *  exists — the caller holds only the serialized text. */
  warnings: SceneWarning[]
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

  for (const op of rest) {
    if (op.op === 'update') elements = await applyUpdate(elements, op)
    else elements = applyDelete(elements, op.id)
  }

  return {
    text: JSON.stringify({ ...scene, elements }, null, 2),
    elementCount: elements.length,
    // The whole scene, not just what this call touched: a new box overlapping an old
    // one is a finding about both, and the caller is the only party that can move
    // either. `font_unavailable` goes first because it explains away every
    // `label_overflow` under it — a box measured against the wrong font is too small
    // for reasons that have nothing to do with the number the caller passed.
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

/**
 * Excalidraw's default font, and the fallback its font string names after it.
 *
 * Neither is configurable from a scene op — `SceneAddOp` carries no `fontFamily`
 * or `fontSize` — so this is the whole set of faces anything here measures with.
 * The third fallback (`Segoe UI Emoji`) is a local system font and needs no load.
 */
const MEASURED_FONT_FAMILIES = ['Excalifont', 'Xiaolai'] as const

/** The size every label is measured at: Excalidraw's `DEFAULT_FONT_SIZE`, which
 *  is what a bound label gets when the skeleton names no size. Font *matching*
 *  ignores it, but `document.fonts.load` wants a complete font shorthand. */
const MEASURED_FONT_SIZE = 20

/**
 * Load the fonts the sizing pass is about to measure with, and don't measure until
 * they are in.
 *
 * This is what keeps a generated shape from clipping its own label. Container
 * dimensions are decided at conversion time by Excalidraw's
 * `redrawTextBoundingBox`, which measures through a canvas 2D context set to
 * `20px Excalifont, Xiaolai, "Segoe UI Emoji"` — and a canvas silently falls back to
 * a generic face for a font that has not loaded. Excalifont is a handwriting font and
 * roughly 20% wider than that fallback (measured: "Authentication Service" is 184px
 * unloaded, 220px loaded), so every box came out sized for a narrower font than the
 * one it would be drawn in. Double-clicking the shape fixed it because opening the
 * text editor puts the font on screen, which loads it, and Excalidraw re-measures on
 * blur.
 *
 * **The faces come from `lib/excalidrawFonts.ts`, not from a mounted editor.** That
 * is the point of it: Excalidraw registers its own faces on mount and offers no way
 * to ask for them otherwise, so anything that waited for an editor could not serve
 * the case `scene_edit` exists for — a file the human is not looking at. Registering
 * them ourselves from the build-time manifest makes the measurement independent of
 * what is on screen, and turns this function back into a plain load.
 *
 * Everything here is best effort: with no fonts available at all the measurement
 * falls back to a narrower face, which is a slightly small box, not a refused edit.
 * **The return value is what makes that visible** — false means every box measured in
 * this call is suspect, and the caller turns it into a `font_unavailable` warning.
 * Silence was the original bug: the drawing came back looking fine to the agent and
 * clipped to the human.
 */
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

  // `check` asks the question the measurement is about to ask — is there a *loaded*
  // face for these characters — rather than whether the load resolved, which catches
  // a subset that failed to fetch.
  //
  // It cannot stand alone, and must not be moved above the registration: `check`
  // answers **true** for a family with no faces at all, because an unmatched family
  // falls through to a system font and a system font is always ready. Verified in the
  // browser — on a page with nothing registered,
  // `document.fonts.check('20px Excalifont', …)` is true while Excalifont is nowhere
  // in `document.fonts`. Only the primary family is asked about: Xiaolai is the CJK
  // fallback, and a Latin label measures against Excalifont whether or not it came.
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

  const updated = elements.map((element) => {
    if (element.id === labelId) {
      // Text only — the geometry is settled by `refit` below, which measures it
      // the same way the add path does rather than guessing at a width here.
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

  // Text, and the box around it, are one measurement — so anything that changes
  // either side of it re-runs that measurement. Without this, rewriting a label
  // left the container at whatever the *previous* text needed, which for longer
  // replacement text is the same clipping the add path used to have; shrinking a
  // box left its label unwrapped and hanging over the edge.
  const resized = op.text !== undefined || op.width !== undefined || op.height !== undefined
  return resized ? refit(updated, op.id) : updated
}

/** Element types Excalidraw's skeleton converter can bind a label inside. A
 *  `line` is deliberately absent — the converter's label branch does not handle
 *  one, so a line's text is a separate element, not a bound label. */
const LABELABLE_TYPES = ['rectangle', 'ellipse', 'diamond', 'arrow'] as const

/**
 * Re-measure `id`'s text and re-fit its box, by running the same skeleton
 * conversion the add path uses.
 *
 * Deliberately delegated rather than reimplemented: Excalidraw's
 * `redrawTextBoundingBox` wraps the text to the container's inner width, grows the
 * container when the wrapped text no longer fits, and re-centres the label in
 * whatever the container became — and none of `measureText`, `wrapText` or
 * `redrawTextBoundingBox` is exported. Handing a one-element skeleton built from
 * the live element back to `convertToExcalidrawElements` gets all of it, at the
 * cost of one throwaway conversion.
 *
 * Only geometry is copied back. The throwaway carries none of the element's
 * identity, bindings or styling, and nothing but width/height/x/y/text is read off
 * it — an arrow's own `points` least of all, since the converter nudges those by a
 * half-pixel when it binds a label to a linear element.
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

  // An arrow is sized by its points, not the other way round: Excalidraw widens a
  // *shape* to fit its label but leaves an arrow alone, and writing the measured
  // width onto one would desync `width` from `points`. Its label's position is
  // re-derived from the path at render time for the same reason, so only the text
  // and its own box are worth copying back.
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

/** One color off an element, or null when the file does not carry it. */
function colorOf(element: ExcalidrawElement, key: 'strokeColor' | 'backgroundColor'): string | null {
  const value = (element as Partial<Record<typeof key, unknown>>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * What is on the canvas, compactly. The full scene JSON is enormous — mostly
 * per-element bookkeeping an agent has no use for — so the default answer is one
 * line per element and the whole file is opt-in.
 *
 * Everything but the `path`, which this cannot know: the text may have come from
 * the open canvas, from a draft, or from a file on the branch. The caller resolved
 * the document and so owns that field.
 */
export function summarizeScene(
  sceneText: string,
  full = false,
): Omit<SceneGetResult, 'path'> {
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
      // A scene *is* its colors — there is no theme layer over a canvas the way
      // there is over a mermaid diagram — so an agent adding to an existing drawing
      // has to see them to match them. Nullable rather than defaulted: a scene file
      // written by another tool may not carry them, and inventing Excalidraw's
      // default here would report a color the element does not have.
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
