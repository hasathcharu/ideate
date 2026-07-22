/**
 * Post-processing for beautiful-mermaid *sequence* diagrams.
 *
 * The upstream renderer has two gaps we fix here, purely by rewriting its (very
 * cleanly annotated) SVG output — no DOM or canvas, so this is deterministic and
 * safe to run during SSR:
 *
 *  1. **Labels bleed out.** Lifelines are spaced by participant-box width only,
 *     not by message-label width, so long labels overflow their arrows. We widen
 *     the gaps between lifelines so every message's arrow span can hold its
 *     label (what stock Mermaid does). The canvas grows to match — fine, since
 *     the preview pans/zooms and has fit-to-screen.
 *
 *  2. **Actors only at the top.** Stock Mermaid mirrors participants at the
 *     bottom too. We clone each actor box to the foot of the lifelines.
 *
 * Anything unexpected → return the input unchanged (diagram still renders).
 */

/** Extra horizontal breathing room on each side of a message label. */
const LABEL_PAD = 16
/** Room a self-message loop + label needs to the right of its lifeline. */
const SELF_EXTRA = 52
/** Approx label width per character at a given font size (Inter, slightly high
 *  so we err toward more spacing rather than residual bleed). */
const CHAR_WIDTH_FACTOR = 0.55

const round = (n: number) => Math.round(n * 1000) / 1000

/** Read a numeric attribute (space-delimited, so `x` never matches `rx`/`dy`). */
function getAttr(tag: string, name: string): number {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([-\\d.eE+]+)"`))
  return m ? parseFloat(m[1]!) : NaN
}

/** Set a numeric attribute, preserving the delimiter before it. */
function setAttr(tag: string, name: string, value: number): string {
  return tag.replace(
    new RegExp(`((?:^|\\s)${name}=")[-\\d.eE+]+(")`),
    `$1${round(value)}$2`,
  )
}

/** Shift every `y=` coordinate in a block by `dy` (used to mirror actors). */
function shiftY(block: string, dy: number): string {
  return block.replace(
    /(\s)y="([-\d.eE+]+)"/g,
    (_m, sp: string, v: string) => `${sp}y="${round(parseFloat(v) + dy)}"`,
  )
}

/** Shift every x coordinate (`x`, `x1`, `x2`) in a block by `dx`. */
function shiftX(block: string, dx: number): string {
  return block.replace(
    /(\s)(x1|x2|x)="([-\d.eE+]+)"/g,
    (_m, sp: string, name: string, v: string) =>
      `${sp}${name}="${round(parseFloat(v) + dx)}"`,
  )
}

/** Shift the x of every "x,y" pair in `points="…"` (self-loop polylines). */
function shiftPointsX(block: string, dx: number): string {
  return block.replace(/points="([^"]*)"/g, (_m, pts: string) => {
    const shifted = pts
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split(',')
        return `${round(parseFloat(x!) + dx)},${y}`
      })
      .join(' ')
    return `points="${shifted}"`
  })
}

/** Rough single-line label width — good enough to size gaps (we add padding). */
function labelWidth(rawLabel: string, fontSize: number): number {
  const text = rawLabel
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
  return text.length * fontSize * CHAR_WIDTH_FACTOR
}

interface Actor {
  id: string
  x: number
  halfWidth: number
}

export function enhanceSequenceSVG(svg: string): string {
  // Fast bail-out for non-sequence diagrams.
  if (!svg.includes('class="lifeline"')) return svg

  try {
    return transform(svg)
  } catch {
    return svg
  }
}

function transform(svg: string): string {
  const rootMatch = svg.match(/<svg\b[^>]*>/)
  if (!rootMatch) return svg
  const rootTag = rootMatch[0]
  const width = getAttr(rootTag, 'width')
  const height = getAttr(rootTag, 'height')
  if (!isFinite(width) || !isFinite(height)) return svg

  const lifelineTags = svg.match(/<line class="lifeline"[^>]*\/?>/g) ?? []
  const actorGroups = svg.match(/<g class="actor"[\s\S]*?<\/g>/g) ?? []
  const messageGroups = svg.match(/<g class="message"[\s\S]*?<\/g>/g) ?? []
  if (lifelineTags.length === 0 || actorGroups.length === 0) return svg

  // Actors ordered left-to-right by lifeline x.
  const actors: Actor[] = lifelineTags
    .map((tag) => {
      const id = tag.match(/data-actor="([^"]*)"/)?.[1] ?? ''
      const x = getAttr(tag, 'x1')
      const group = actorGroups.find((g) => g.includes(`data-id="${id}"`))
      const rect = group?.match(/<rect[^>]*\/?>/)?.[0]
      const halfWidth = rect ? getAttr(rect, 'width') / 2 : 0
      return { id, x, halfWidth }
    })
    .filter((a) => a.id && isFinite(a.x))
    .sort((a, b) => a.x - b.x)

  const n = actors.length
  const indexOf = new Map(actors.map((a, i) => [a.id, i]))

  // --- 1. Reflow x so message labels fit their arrow spans -----------------
  // Only for plain message diagrams: notes and loop/alt "block" frames span
  // lifelines and would be left misaligned by a naive reflow, so we skip
  // widening (labels there may still overflow) but still mirror actors below.
  const canReflow =
    n >= 2 && !svg.includes('class="note"') && !svg.includes('class="block"')

  let newX = actors.map((a) => a.x)
  let delta = actors.map(() => 0)
  let newWidth = width

  if (canReflow) {
    const gaps: number[] = []
    for (let i = 0; i < n - 1; i++) gaps.push(actors[i + 1]!.x - actors[i]!.x)

    const requirements: Array<{ p: number; q: number; need: number }> = []
    let rightExtra = 0
    for (const grp of messageGroups) {
      const fromId = grp.match(/data-from="([^"]*)"/)?.[1]
      const toId = grp.match(/data-to="([^"]*)"/)?.[1]
      const label = grp.match(/data-label="([^"]*)"/)?.[1] ?? ''
      const self = grp.includes('data-self="true"')
      if (fromId == null || toId == null) continue
      const from = indexOf.get(fromId)
      const to = indexOf.get(toId)
      if (from == null || to == null) continue
      const w = labelWidth(label, 11)
      if (self) {
        if (from < n - 1) requirements.push({ p: from, q: from + 1, need: w + SELF_EXTRA })
        else rightExtra = Math.max(rightExtra, w + SELF_EXTRA)
      } else {
        const p = Math.min(from, to)
        const q = Math.max(from, to)
        if (q > p) requirements.push({ p, q, need: w + LABEL_PAD * 2 })
      }
    }

    // Relaxation: only ever *widen* gaps (keeps box spacing valid), a few passes
    // so multi-actor spans settle.
    const spanSum = (p: number, q: number) => {
      let s = 0
      for (let i = p; i < q; i++) s += gaps[i]!
      return s
    }
    for (let pass = 0; pass < 3; pass++) {
      for (const { p, q, need } of requirements) {
        const cur = spanSum(p, q)
        if (cur < need) {
          const per = (need - cur) / (q - p)
          for (let i = p; i < q; i++) gaps[i]! += per
        }
      }
    }

    newX = [actors[0]!.x]
    for (let i = 1; i < n; i++) newX[i] = newX[i - 1]! + gaps[i - 1]!
    delta = actors.map((a, i) => newX[i]! - a.x)

    // Right padding preserved from the original layout.
    const origRight = Math.max(...actors.map((a) => a.x + a.halfWidth))
    const rightPad = width - origRight
    const newRight = Math.max(...actors.map((a, i) => newX[i]! + a.halfWidth))
    newWidth = newRight + rightPad + rightExtra
  }

  let out = svg

  // Lifelines → new x.
  for (const tag of lifelineTags) {
    const id = tag.match(/data-actor="([^"]*)"/)?.[1] ?? ''
    const i = indexOf.get(id)
    if (i == null) continue
    const moved = setAttr(setAttr(tag, 'x1', newX[i]!), 'x2', newX[i]!)
    out = out.replace(tag, moved)
  }

  // Actor boxes → shift by their delta.
  for (const grp of actorGroups) {
    const id = grp.match(/data-id="([^"]*)"/)?.[1] ?? ''
    const i = indexOf.get(id)
    if (i == null) continue
    out = out.replace(grp, shiftX(grp, delta[i]!))
  }

  // Messages → self loops shift; straight arrows get repositioned endpoints.
  for (const grp of messageGroups) {
    const fromId = grp.match(/data-from="([^"]*)"/)?.[1] ?? ''
    const toId = grp.match(/data-to="([^"]*)"/)?.[1] ?? ''
    const from = indexOf.get(fromId)
    const to = indexOf.get(toId)
    if (from == null || to == null) continue
    if (grp.includes('data-self="true"')) {
      // Self loops carry their geometry in a <polyline points="…"> plus a
      // <text x="…">, so shift both by the actor's delta.
      out = out.replace(grp, shiftPointsX(shiftX(grp, delta[from]!), delta[from]!))
      continue
    }
    const lineTag = grp.match(/<line\b[^>]*\/?>/)?.[0]
    const textTag = grp.match(/<text\b[^>]*>[\s\S]*?<\/text>/)?.[0]
    let moved = grp
    if (lineTag) {
      const newLine = setAttr(setAttr(lineTag, 'x1', newX[from]!), 'x2', newX[to]!)
      moved = moved.replace(lineTag, newLine)
    }
    if (textTag) {
      const mid = (newX[from]! + newX[to]!) / 2
      moved = moved.replace(textTag, setAttr(textTag, 'x', mid))
    }
    out = out.replace(grp, moved)
  }

  // --- 2. Mirror actors to the bottom --------------------------------------
  const firstRect = actorGroups[0]?.match(/<rect[^>]*\/?>/)?.[0]
  const topRectY = firstRect ? getAttr(firstRect, 'y') : NaN
  const boxHeight = firstRect ? getAttr(firstRect, 'height') : NaN
  const bottomY = Math.max(...lifelineTags.map((t) => getAttr(t, 'y2')))

  let newHeight = height
  if (isFinite(topRectY) && isFinite(boxHeight) && isFinite(bottomY)) {
    const dy = bottomY - topRectY
    // Re-read the (already x-shifted) actor groups from `out` and mirror them.
    const shifted = out.match(/<g class="actor"[\s\S]*?<\/g>/g) ?? []
    const mirrored = shifted
      .map((g) => shiftY(g, dy).replace('class="actor"', 'class="actor actor-mirror"'))
      .join('\n')
    out = out.replace('</svg>', `${mirrored}</svg>`)
    newHeight = height + boxHeight
  }

  // Resize the canvas for the new width/height.
  let newRoot = setAttr(setAttr(rootTag, 'width', newWidth), 'height', newHeight)
  newRoot = newRoot.replace(
    /viewBox="[^"]*"/,
    `viewBox="0 0 ${round(newWidth)} ${round(newHeight)}"`,
  )
  out = out.replace(rootTag, newRoot)

  return out
}
