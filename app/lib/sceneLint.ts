import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { SceneWarning, SceneWarningKind } from './agentProtocol'

/**
 * Layout defects in an Excalidraw scene, reported back to the agent that drew it.
 *
 * This is `ideate_check` for a canvas, and it exists for the same reason: an agent
 * editing a diagram cannot see the result, so the renderer's verdict has to come
 * back in the result of its own tool call. A mermaid diagram gets that for free —
 * mermaid parses it and dagre lays it out. A scene has no parser to fail and no
 * layout engine to appeal to: `scene_edit` takes absolute pixel coordinates, so the
 * *agent* is the layout engine, and it is one working blind. Overlapping shapes,
 * arrows drawn straight through a box, and a label wider than the box holding it
 * are all silent successes without this.
 *
 * Nothing here is an error. Every finding is a warning carrying the ids it concerns
 * and a number the caller can act on, because most of them are judgements — a shape
 * inside a shape may be a mistake or a deliberate group, and only the caller knows
 * which. Refusing an edit over a guess would be worse than drawing it.
 *
 * **Pure geometry, and no `@excalidraw/excalidraw` value import** (rule 8): every
 * measurement below reads fields off elements the converter has already produced.
 * That is what lets this run on the way out of `applySceneOps` and inside
 * `summarizeScene` without either becoming a dynamic-import site.
 */

/** Inner padding Excalidraw leaves around a bound label (`BOUND_TEXT_PADDING`).
 *  Hardcoded because it is not exported, and it is the number the container's own
 *  sizing pass uses. */
const BOUND_TEXT_PADDING = 5

/** Overlap smaller than this is a rounding artefact, not a layout mistake. */
const OVERLAP_TOLERANCE = 2

/** How close two edges have to be before "nearly aligned" reads as "meant to be
 *  aligned and isn't". Tight on purpose: 4px is invisible as a design choice and
 *  obvious as arithmetic that went wrong. */
const ALIGN_TOLERANCE = 4

/** How far a free arrow endpoint may sit from a shape before it stops looking like
 *  it was aiming at it. */
const UNBOUND_REACH = 16

/** Rects are shrunk by this before an arrow is tested against them, so an arrow
 *  that merely grazes a corner is not reported as passing through the shape. */
const CROSSING_INSET = 3

/** At most this many findings of any one kind, and this many in total. A scene with
 *  forty overlapping boxes needs to be told that once, and the cap is what keeps a
 *  single noisy check from crowding out the other seven. */
const PER_KIND_LIMIT = 6
const TOTAL_LIMIT = 24

/** Element types with an area an arrow can hit and a label can sit in. */
const SHAPE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'image', 'frame'])

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

/**
 * Lint `elements`.
 *
 * Takes elements rather than scene text so the two call sites can share it:
 * `applySceneOps` holds the array it just built, and re-serializing it only to
 * parse it again would be the same work done twice.
 */
export function lintScene(elements: readonly ExcalidrawElement[]): SceneWarning[] {
  const live = elements.filter((element) => !element.isDeleted)
  const byId = new Map(live.map((element) => [element.id, element]))

  const shapes = live.filter((element) => SHAPE_TYPES.has(element.type))
  const arrows = live.filter((element) => element.type === 'arrow' || element.type === 'line')
  const labels = live.filter((element) => element.type === 'text' && containerOf(element) !== null)
  const freeText = live.filter((element) => element.type === 'text' && containerOf(element) === null)

  const found = new Collector()
  // Built here rather than looked up per message: a container's caption is a
  // separate text element pointing back at it, so without this every rectangle in
  // every message below would be named by its id alone.
  const names = new Namer(labels)

  labelOverflow(found, labels, byId)
  textNotBound(found, freeText, shapes)
  overlaps(found, shapes, names)
  arrowsCrossing(found, arrows, shapes, names)
  duplicateArrows(found, arrows, byId, names)
  unboundArrows(found, arrows, shapes, names)
  nearMisses(found, shapes)

  return found.all()
}

/**
 * A bounded, per-kind-fair accumulator.
 *
 * Ordering matters as much as the caps: the checks are called in descending order
 * of how likely a finding is to be a real defect rather than a style opinion, and
 * `all()` preserves that, so a truncated list is truncated from the least useful
 * end.
 */
class Collector {
  private readonly warnings: SceneWarning[] = []
  private readonly counts = new Map<SceneWarningKind, number>()

  push(kind: SceneWarningKind, ids: string[], message: string): void {
    if (this.warnings.length >= TOTAL_LIMIT) return
    const seen = this.counts.get(kind) ?? 0
    if (seen >= PER_KIND_LIMIT) return
    this.counts.set(kind, seen + 1)
    this.warnings.push({ kind, ids, message })
  }

  /** True once this kind can take no more, so a caller can stop walking an O(n^2)
   *  pair loop it has no way to report from. */
  full(kind: SceneWarningKind): boolean {
    return this.warnings.length >= TOTAL_LIMIT || (this.counts.get(kind) ?? 0) >= PER_KIND_LIMIT
  }

  all(): SceneWarning[] {
    return this.warnings
  }
}

/* ------------------------------------------------------------------ */
/* The checks                                                          */
/* ------------------------------------------------------------------ */

/**
 * A label that does not fit the box it is bound to.
 *
 * The most consequential check here, because it is the one failure the agent gets
 * blamed for and did not cause: a container is sized by a canvas `measureText`
 * against Excalidraw's own font, and a font that has not loaded measures ~20%
 * narrow — see `awaitTextFonts` in `lib/sceneEdit.ts`. Whatever the cause, the
 * remedy is a number, so the message carries one.
 */
function labelOverflow(
  found: Collector,
  labels: readonly ExcalidrawElement[],
  byId: ReadonlyMap<string, ExcalidrawElement>,
): void {
  for (const label of labels) {
    if (found.full('label_overflow')) return
    const container = byId.get(containerOf(label)!)
    // An arrow's label is positioned along its path and the arrow is never resized
    // to hold it, so there is no box for it to overflow.
    if (!container || !SHAPE_TYPES.has(container.type)) continue

    const room = {
      width: container.width - BOUND_TEXT_PADDING * 2,
      height: container.height - BOUND_TEXT_PADDING * 2,
    }
    const overWidth = label.width - room.width
    const overHeight = label.height - room.height
    if (overWidth <= 1 && overHeight <= 1) continue

    const widthIsWorse = overWidth > overHeight
    const needed = widthIsWorse
      ? `at least ${Math.ceil(label.width + BOUND_TEXT_PADDING * 2)} wide`
      : `at least ${Math.ceil(label.height + BOUND_TEXT_PADDING * 2)} tall`
    found.push(
      'label_overflow',
      [container.id, label.id],
      `The label ${quote(label) || label.id} is ${widthIsWorse ? 'wider' : 'taller'} than the ` +
        `${container.type} holding it (${Math.ceil(label.width)}x${Math.ceil(label.height)} ` +
        `inside ${Math.round(room.width)}x${Math.round(room.height)} of room), so the text ` +
        `runs outside the shape. Make the ${container.type} ${needed}, or shorten the text.`,
    )
  }
}

/**
 * A standalone text element sitting inside a shape.
 *
 * Almost always an agent that placed two elements where it wanted one: a text
 * element is not bound to the shape it happens to sit on, so it does not move with
 * it, does not wrap to it, and is not deleted with it. The fix is the `text` field
 * on the shape's own op, which is a different call rather than a nudge.
 */
function textNotBound(
  found: Collector,
  freeText: readonly ExcalidrawElement[],
  shapes: readonly ExcalidrawElement[],
): void {
  for (const text of freeText) {
    if (found.full('text_not_bound')) return
    const middle = centre(text)
    const host = shapes.find((shape) => shape.type !== 'frame' && contains(shape, middle))
    if (!host) continue
    found.push(
      'text_not_bound',
      [text.id, host.id],
      `The text ${quote(text) || text.id} sits inside the ${host.type} ${host.id} but is a separate ` +
        `element, so it will not move, resize or delete with it. Delete the text and pass the ` +
        `same string as \`text\` on the ${host.type} instead, which binds it as a centred label.`,
    )
  }
}

/** Two shapes drawn over each other. Full containment is skipped: a big rectangle
 *  behind a group of smaller ones is a normal way to draw, and reporting it would
 *  fire on every legitimate grouping. */
function overlaps(
  found: Collector,
  shapes: readonly ExcalidrawElement[],
  names: Namer,
): void {
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      if (found.full('overlap')) return
      const a = shapes[i]!
      const b = shapes[j]!
      // A frame is a container by definition; everything in it overlaps it.
      if (a.type === 'frame' || b.type === 'frame') continue
      if (contains(a, b) || contains(b, a)) continue
      const shared = intersection(a, b)
      if (!shared) continue
      found.push(
        'overlap',
        [a.id, b.id],
        `The ${a.type} ${a.id}${names.caption(a)} and the ${b.type} ${b.id}${names.caption(b)} ` +
          `overlap by ` +
          `${Math.round(shared.width)}x${Math.round(shared.height)}px. Move one of them: a gap ` +
          `of 40 to 80px between neighbouring shapes is what the arrows between them need.`,
      )
    }
  }
}

/** An arrow drawn through a shape it has nothing to do with. The single biggest
 *  cause of a diagram reading as spaghetti, and invisible to the caller, which only
 *  ever named two endpoints. */
function arrowsCrossing(
  found: Collector,
  arrows: readonly ExcalidrawElement[],
  shapes: readonly ExcalidrawElement[],
  names: Namer,
): void {
  for (const arrow of arrows) {
    if (found.full('arrow_crosses')) return
    const ends = boundIds(arrow)
    const path = absolutePoints(arrow)
    if (path.length < 2) continue

    for (const shape of shapes) {
      if (ends.has(shape.id) || shape.type === 'frame') continue
      const box = inset(shape, CROSSING_INSET)
      if (box.width <= 0 || box.height <= 0) continue
      const hit = path.some((point, index) => {
        const next = path[index + 1]
        return next !== undefined && segmentHitsRect(point, next, box)
      })
      if (!hit) continue
      found.push(
        'arrow_crosses',
        [arrow.id, shape.id],
        `The ${arrow.type} ${arrow.id} passes straight through the ${shape.type} ${shape.id}` +
          `${names.caption(shape)}, which is not one of its endpoints. Move the shapes it joins so ` +
          `nothing sits between them, or route around it by giving the ${arrow.type} explicit ` +
          `\`points\` with a bend in them.`,
      )
      break
    }
  }
}

/** Two or more arrows joining the same pair of shapes. Both are routed centre to
 *  centre, so they are drawn on top of each other and read as one. */
function duplicateArrows(
  found: Collector,
  arrows: readonly ExcalidrawElement[],
  byId: ReadonlyMap<string, ExcalidrawElement>,
  names: Namer,
): void {
  const pairs = new Map<string, string[]>()
  for (const arrow of arrows) {
    const ends = [...boundIds(arrow)]
    if (ends.length !== 2) continue
    // Unordered: A to B drawn on top of B to A is the same collision, and the fact
    // that one of them points the other way does not separate them on screen.
    const key = [...ends].sort().join(' ')
    pairs.set(key, [...(pairs.get(key) ?? []), arrow.id])
  }

  for (const [key, ids] of pairs) {
    if (found.full('arrow_duplicate')) return
    if (ids.length < 2) continue
    const [a, b] = key.split(' ')
    found.push(
      'arrow_duplicate',
      ids,
      `${ids.length} arrows join ${names.describe(byId.get(a!))} and ` +
        `${names.describe(byId.get(b!))}. They ` +
        `are all routed centre to centre, so they are drawn on top of one another. Keep one and ` +
        `put both meanings in its label, or give the extras explicit \`points\` so they take a ` +
        `different path.`,
    )
  }
}

/** An arrow endpoint left free next to the shape it was clearly aiming at. It looks
 *  right until the human drags the shape, and then it stays behind. */
function unboundArrows(
  found: Collector,
  arrows: readonly ExcalidrawElement[],
  shapes: readonly ExcalidrawElement[],
  names: Namer,
): void {
  for (const arrow of arrows) {
    if (found.full('arrow_unbound')) return
    const path = absolutePoints(arrow)
    if (path.length < 2) continue
    const bindings = arrow as { startBinding?: unknown; endBinding?: unknown }

    for (const end of ['start', 'end'] as const) {
      if (end === 'start' ? bindings.startBinding : bindings.endBinding) continue
      const point = end === 'start' ? path[0]! : path[path.length - 1]!
      const near = shapes.find(
        (shape) => shape.type !== 'frame' && contains(inflate(shape, UNBOUND_REACH), point),
      )
      if (!near) continue
      found.push(
        'arrow_unbound',
        [arrow.id, near.id],
        `The ${arrow.type} ${arrow.id} ${end}s next to the ${near.type} ${near.id}` +
          `${names.caption(near)} but is not attached to it, so it will be left behind the moment ` +
          `that shape is moved. Redraw it with \`${end}\` set to "${near.id}" and let the arrow ` +
          `be routed for you.`,
      )
      break
    }
  }
}

/**
 * Edges that are close to lining up without doing so.
 *
 * The tell of coordinates worked out by hand: a column of boxes at x = 100, 100,
 * 103 was meant to be a column. Reported last and capped hardest, because unlike
 * everything above it this is cosmetic — and reported at all because it is the
 * defect a caller has no way to notice and the cheapest one to fix.
 */
function nearMisses(found: Collector, shapes: readonly ExcalidrawElement[]): void {
  // Grouped by the axis they measure along, and that grouping is load-bearing —
  // see the exact-alignment escape below.
  const groups: Array<Array<{ name: string; of: (rect: Rect) => number }>> = [
    [
      { name: 'left edges', of: (r) => r.x },
      { name: 'horizontal centres', of: (r) => r.x + r.width / 2 },
      { name: 'right edges', of: (r) => r.x + r.width },
    ],
    [
      { name: 'top edges', of: (r) => r.y },
      { name: 'vertical centres', of: (r) => r.y + r.height / 2 },
      { name: 'bottom edges', of: (r) => r.y + r.height },
    ],
  ]

  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      if (found.full('misaligned')) return
      const a = shapes[i]!
      const b = shapes[j]!
      for (const group of groups) {
        const gaps = group.map((axis) => ({ axis, gap: Math.abs(axis.of(a) - axis.of(b)) }))
        // Exactly aligned on *any* axis in this direction settles the direction, and
        // the other two axes are then consequences rather than decisions. This is
        // not a nicety: a left-aligned column of boxes auto-sized to their own
        // labels has three different widths and therefore three right edges a couple
        // of pixels apart, and reporting that would fire on the best-laid-out drawing
        // an agent can produce. Below half a pixel is the measurement pass rounding.
        if (gaps.some(({ gap }) => gap < 0.5)) continue

        const near = gaps
          .filter(({ gap }) => gap <= ALIGN_TOLERANCE)
          .sort((one, two) => one.gap - two.gap)[0]
        if (!near) continue
        found.push(
          'misaligned',
          [a.id, b.id],
          `The ${near.axis.name} of ${a.type} ${a.id} and ${b.type} ${b.id} are ` +
            `${near.gap.toFixed(1)}px apart, which is close enough to look like a mistake ` +
            `rather than a choice. Give them the same value, and place shapes on a 20px grid ` +
            `so this cannot happen.`,
        )
        break
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

function containerOf(element: ExcalidrawElement): string | null {
  return (element as { containerId?: string | null }).containerId ?? null
}

/** The ids an arrow is attached to, in either direction. */
function boundIds(arrow: ExcalidrawElement): Set<string> {
  const bindings = arrow as {
    startBinding?: { elementId?: string } | null
    endBinding?: { elementId?: string } | null
  }
  const ids = new Set<string>()
  if (bindings.startBinding?.elementId) ids.add(bindings.startBinding.elementId)
  if (bindings.endBinding?.elementId) ids.add(bindings.endBinding.elementId)
  return ids
}

/** An arrow's vertices in scene coordinates. Stored `points` are relative to the
 *  element origin, and every test here is against absolute rects. */
function absolutePoints(arrow: ExcalidrawElement): Point[] {
  const points = (arrow as { points?: readonly (readonly number[])[] }).points ?? []
  return points
    .filter((point) => point.length >= 2)
    .map((point) => ({ x: arrow.x + point[0]!, y: arrow.y + point[1]! }))
}

function centre(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function contains(rect: Rect, inner: Rect | Point): boolean {
  const box = 'width' in inner ? inner : { ...inner, width: 0, height: 0 }
  return (
    box.x >= rect.x &&
    box.y >= rect.y &&
    box.x + box.width <= rect.x + rect.width &&
    box.y + box.height <= rect.y + rect.height
  )
}

/** The shared area of two rects, or null when they only touch. */
function intersection(a: Rect, b: Rect): { width: number; height: number } | null {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= OVERLAP_TOLERANCE || height <= OVERLAP_TOLERANCE) return null
  return { width, height }
}

function inset(rect: Rect, by: number): Rect {
  return { x: rect.x + by, y: rect.y + by, width: rect.width - by * 2, height: rect.height - by * 2 }
}

function inflate(rect: Rect, by: number): Rect {
  return inset(rect, -by)
}

/** Does the segment `p`-`q` enter `rect`? Either endpoint inside counts, and so
 *  does a crossing with any of the four sides — a segment can pass clean through
 *  with both endpoints outside, which is the case this check exists for. */
function segmentHitsRect(p: Point, q: Point, rect: Rect): boolean {
  if (contains(rect, p) || contains(rect, q)) return true
  const corners: Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ]
  return corners.some((corner, index) =>
    segmentsCross(p, q, corner, corners[(index + 1) % corners.length]!),
  )
}

/** Proper segment intersection by orientation sign. Collinear overlap answers
 *  false: an arrow drawn exactly along a shape's edge is a styling choice, and the
 *  degenerate cases are not worth the false positives. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  return d1 * d2 < 0 && d3 * d4 < 0
}

function cross(from: Point, to: Point, point: Point): number {
  return (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x)
}

/* ------------------------------------------------------------------ */
/* Naming things in a message                                          */
/* ------------------------------------------------------------------ */

/** `"Auth"`, shortened and quoted — what makes a message about an id readable to
 *  the human who reads the transcript afterwards. Empty string when the element
 *  carries no text of its own. */
function quote(element: ExcalidrawElement): string {
  const source = element as { originalText?: string; text?: string }
  return shorten((source.originalText ?? source.text ?? '').replace(/\s+/g, ' ').trim())
}

function shorten(text: string): string {
  if (!text) return ''
  return `"${text.length > 40 ? `${text.slice(0, 39)}...` : text}"`
}

/**
 * Names elements in a message.
 *
 * A shape holds no text: its caption is a `text` element with a `containerId`
 * pointing back at it, which is why this is a small object holding a map rather
 * than two free functions.
 */
class Namer {
  private readonly captions = new Map<string, string>()

  constructor(labels: readonly ExcalidrawElement[]) {
    for (const label of labels) {
      const text = quote(label)
      if (text) this.captions.set(containerOf(label)!, text)
    }
  }

  /** ` ("Auth")`, or nothing at all when the element has no caption — it is
   *  appended to an id, so it must not read as an empty pair of brackets. */
  caption(element: ExcalidrawElement): string {
    const text = this.captions.get(element.id) || quote(element)
    return text ? ` (${text})` : ''
  }

  describe(element: ExcalidrawElement | undefined): string {
    if (!element) return 'a shape that is no longer on the canvas'
    return `${element.type} ${element.id}${this.caption(element)}`
  }
}
