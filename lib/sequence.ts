/**
 * Post-processing for beautiful-mermaid *sequence* diagrams.
 *
 * The upstream renderer spaces lifelines by participant-box width only (ignoring
 * message / note label widths) and never mirrors participants to the bottom. We
 * fix both by rewriting its (cleanly annotated) SVG:
 *
 *  1. **Reflow x** so every message arrow and note is wide enough for its label.
 *     Label widths are *measured* (canvas `measureText` in the browser; a
 *     deterministic estimate during SSR). New lifeline positions define a
 *     piecewise-linear map applied to every content x-coordinate, so lifelines,
 *     messages, self-loops, notes and loop/alt frames all move and resize
 *     together — no element type is left behind.
 *
 *  2. **Mirror actors** to the foot of the lifelines (as stock Mermaid does).
 *
 * Everything is a deterministic string rewrite (SSR-safe). Any failure returns
 * the input unchanged so the diagram still renders.
 */

const LABEL_PAD = 20 // breathing room each side of a message label
const NOTE_PAD = 16 // breathing room each side of a note label
const SELF_LOOP = 36 // width a self-message loop occupies before its label

const round = (n: number) => Math.round(n * 1000) / 1000

/* ------------------------------------------------------------------ */
/* Text measurement                                                    */
/* ------------------------------------------------------------------ */

let measureCtx: CanvasRenderingContext2D | null | undefined

function decodeLabel(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** Width of `text` at the given font — real measurement in the browser. */
function measureText(text: string, fontPx: number, weight = 400): number {
  const label = decodeLabel(text)
  if (measureCtx === undefined) {
    measureCtx =
      typeof document !== 'undefined'
        ? document.createElement('canvas').getContext('2d')
        : null
  }
  if (measureCtx) {
    measureCtx.font = `${weight} ${fontPx}px Inter, system-ui, sans-serif`
    return measureCtx.measureText(label).width
  }
  // SSR fallback: rough estimate (the client re-measures on mount).
  return label.length * fontPx * 0.55
}

/* ------------------------------------------------------------------ */
/* Attribute / coordinate helpers                                      */
/* ------------------------------------------------------------------ */

/** Read a numeric attribute (space-delimited, so `x` never matches `rx`/`dy`). */
function getAttr(tag: string, name: string): number {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([-\\d.eE+]+)"`))
  return m ? parseFloat(m[1]!) : NaN
}

function setAttr(tag: string, name: string, value: number): string {
  return tag.replace(
    new RegExp(`((?:^|\\s)${name}=")[-\\d.eE+]+(")`),
    `$1${round(value)}$2`,
  )
}

/** Shift every y coordinate (`y`, `y1`, `y2`, `cy`) in a block by `dy`. */
function shiftY(block: string, dy: number): string {
  return block.replace(
    /(\s)(y1|y2|cy|y)="([-\d.eE+]+)"/g,
    (_m, sp: string, name: string, v: string) =>
      `${sp}${name}="${round(parseFloat(v) + dy)}"`,
  )
}

type XMap = (x: number) => number

/** Remap the x of every "x,y" pair in a comma-paired `points="…"`. */
function remapPoints(pointsAttr: string, f: XMap): string {
  return pointsAttr
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',')
      if (y === undefined) return pair // not comma-paired; leave alone
      return `${round(f(parseFloat(x!)))},${y}`
    })
    .join(' ')
}

/** Apply the x-map to a single content tag according to its element type. */
function remapTag(tag: string, f: XMap): string {
  const name = tag.match(/^<(\w+)/)?.[1]
  if (!name) return tag
  switch (name) {
    case 'rect': {
      const x = getAttr(tag, 'x')
      const w = getAttr(tag, 'width')
      let out = tag
      if (isFinite(x)) {
        const nx = f(x)
        out = setAttr(out, 'x', nx)
        if (isFinite(w)) out = setAttr(out, 'width', f(x + w) - nx)
      }
      return out
    }
    case 'line': {
      let out = tag
      if (isFinite(getAttr(tag, 'x1'))) out = setAttr(out, 'x1', f(getAttr(tag, 'x1')))
      if (isFinite(getAttr(tag, 'x2'))) out = setAttr(out, 'x2', f(getAttr(tag, 'x2')))
      return out
    }
    case 'polyline':
    case 'polygon': {
      const m = tag.match(/points="([^"]*)"/)
      if (!m) return tag
      return tag.replace(/points="[^"]*"/, `points="${remapPoints(m[1]!, f)}"`)
    }
    case 'circle':
      return isFinite(getAttr(tag, 'cx')) ? setAttr(tag, 'cx', f(getAttr(tag, 'cx'))) : tag
    case 'text':
    case 'tspan':
      return isFinite(getAttr(tag, 'x')) ? setAttr(tag, 'x', f(getAttr(tag, 'x'))) : tag
    default:
      return tag
  }
}

/* ------------------------------------------------------------------ */
/* Transform                                                           */
/* ------------------------------------------------------------------ */

export function enhanceSequenceSVG(svg: string): string {
  if (!svg.includes('class="lifeline"')) return svg
  try {
    return transform(svg)
  } catch {
    return svg
  }
}

interface Actor {
  id: string
  x: number
  halfWidth: number
}

function transform(svg: string): string {
  const rootTag = svg.match(/<svg\b[^>]*>/)?.[0]
  if (!rootTag) return svg
  const width = getAttr(rootTag, 'width')
  const height = getAttr(rootTag, 'height')
  if (!isFinite(width) || !isFinite(height)) return svg

  const lifelineTags = svg.match(/<line class="lifeline"[^>]*\/?>/g) ?? []
  const actorGroups = svg.match(/<g class="actor"[\s\S]*?<\/g>/g) ?? []
  if (lifelineTags.length === 0 || actorGroups.length === 0) return svg

  const actors: Actor[] = lifelineTags
    .map((tag) => {
      const id = tag.match(/data-actor="([^"]*)"/)?.[1] ?? ''
      const x = getAttr(tag, 'x1')
      const rect = actorGroups
        .find((g) => g.includes(`data-id="${id}"`))
        ?.match(/<rect[^>]*\/?>/)?.[0]
      const halfWidth = rect ? getAttr(rect, 'width') / 2 : 0
      return { id, x, halfWidth }
    })
    .filter((a) => a.id && isFinite(a.x))
    .sort((a, b) => a.x - b.x)

  const n = actors.length
  if (n === 0) return svg
  const indexOf = new Map(actors.map((a, i) => [a.id, i]))
  const oldX = actors.map((a) => a.x)

  // --- 1. Compute required lifeline gaps -----------------------------------
  const gaps: number[] = []
  for (let i = 0; i < n - 1; i++) gaps.push(oldX[i + 1]! - oldX[i]!)

  const reqs: Array<{ p: number; q: number; need: number }> = []
  let leftExtra = 0
  let rightExtra = 0
  const wantGap = (i: number, need: number) => {
    if (i >= 0 && i < n - 1) reqs.push({ p: i, q: i + 1, need })
  }

  // Messages.
  for (const grp of svg.match(/<g class="message"[\s\S]*?<\/g>/g) ?? []) {
    const from = indexOf.get(grp.match(/data-from="([^"]*)"/)?.[1] ?? '')
    const to = indexOf.get(grp.match(/data-to="([^"]*)"/)?.[1] ?? '')
    if (from == null || to == null) continue
    const w = measureText(grp.match(/data-label="([^"]*)"/)?.[1] ?? '', 11)
    if (grp.includes('data-self="true"')) {
      const need = w + SELF_LOOP + LABEL_PAD
      if (from < n - 1) wantGap(from, need)
      else rightExtra = Math.max(rightExtra, need)
    } else {
      const p = Math.min(from, to)
      const q = Math.max(from, to)
      if (q > p) reqs.push({ p, q, need: w + LABEL_PAD * 2 })
    }
  }

  // Notes (over one or more actors).
  for (const grp of svg.match(/<g class="note"[\s\S]*?<\/g>/g) ?? []) {
    const ids = (grp.match(/data-actors="([^"]*)"/)?.[1] ?? '')
      .split(',')
      .map((id) => indexOf.get(id.trim()))
      .filter((i): i is number => i != null)
    if (ids.length === 0) continue
    const p = Math.min(...ids)
    const q = Math.max(...ids)
    const text = grp.match(/<text\b[^>]*>([\s\S]*?)<\/text>/)?.[1] ?? ''
    const w = measureText(text, 11)
    if (q > p) {
      reqs.push({ p, q, need: w + NOTE_PAD * 2 })
    } else {
      const half = w / 2 + NOTE_PAD
      wantGap(p - 1, half)
      wantGap(p, half)
      if (p === 0) leftExtra = Math.max(leftExtra, half - (oldX[0]! - actors[0]!.halfWidth))
      if (p === n - 1) rightExtra = Math.max(rightExtra, half)
    }
  }

  // Relax gaps: only ever widen (keeps box spacing valid), a few passes so
  // multi-actor spans settle.
  const spanSum = (p: number, q: number) => {
    let s = 0
    for (let i = p; i < q; i++) s += gaps[i]!
    return s
  }
  for (let pass = 0; pass < 3; pass++) {
    for (const { p, q, need } of reqs) {
      const cur = spanSum(p, q)
      if (cur < need) {
        const per = (need - cur) / (q - p)
        for (let i = p; i < q; i++) gaps[i]! += per
      }
    }
  }

  const shift = Math.max(0, leftExtra)
  const newX = [oldX[0]! + shift]
  for (let i = 1; i < n; i++) newX[i] = newX[i - 1]! + gaps[i - 1]!
  const changed = shift > 0 || newX.some((x, i) => Math.abs(x - oldX[i]!) > 0.01)

  // Piecewise-linear map old-x → new-x (identity slope beyond the ends).
  const f: XMap = (x) => {
    if (n === 1) return x + (newX[0]! - oldX[0]!)
    if (x <= oldX[0]!) return newX[0]! + (x - oldX[0]!)
    if (x >= oldX[n - 1]!) return newX[n - 1]! + (x - oldX[n - 1]!)
    for (let i = 0; i < n - 1; i++) {
      if (x <= oldX[i + 1]!) {
        const span = oldX[i + 1]! - oldX[i]! || 1
        return newX[i]! + ((x - oldX[i]!) / span) * (newX[i + 1]! - newX[i]!)
      }
    }
    return x
  }

  let out = svg
  if (changed) {
    // Protect <defs> (arrow markers use a different points format) and <style>.
    const defs = out.match(/<defs>[\s\S]*?<\/defs>/)?.[0]
    const style = out.match(/<style>[\s\S]*?<\/style>/)?.[0]
    if (defs) out = out.replace(defs, ' DEFS ')
    if (style) out = out.replace(style, ' STYLE ')
    out = out.replace(
      /<(rect|line|polyline|polygon|circle|text|tspan)\b[^>]*?>/g,
      (tag) => remapTag(tag, f),
    )
    if (defs) out = out.replace(' DEFS ', defs)
    if (style) out = out.replace(' STYLE ', style)
  }

  // --- 2. Mirror actors to the bottom --------------------------------------
  const firstRect = actorGroups[0]?.match(/<rect[^>]*\/?>/)?.[0]
  const topRectY = firstRect ? getAttr(firstRect, 'y') : NaN
  const boxHeight = firstRect ? getAttr(firstRect, 'height') : NaN
  const bottomY = Math.max(...lifelineTags.map((t) => getAttr(t, 'y2')))

  let newHeight = height
  if (isFinite(topRectY) && isFinite(boxHeight) && isFinite(bottomY) && bottomY > topRectY) {
    const dy = bottomY - topRectY
    const shifted = out.match(/<g class="actor"[\s\S]*?<\/g>/g) ?? []
    const mirrored = shifted
      .map((g) => shiftY(g, dy).replace('class="actor"', 'class="actor actor-mirror"'))
      .join('\n')
    out = out.replace('</svg>', `${mirrored}</svg>`)
    newHeight = height + boxHeight
  }

  // --- Resize canvas -------------------------------------------------------
  const origRight = Math.max(...actors.map((a) => a.x + a.halfWidth))
  const rightPad = width - origRight
  const newWidth = f(origRight) + rightPad + rightExtra

  let newRoot = setAttr(setAttr(rootTag, 'width', newWidth), 'height', newHeight)
  newRoot = newRoot.replace(
    /viewBox="[^"]*"/,
    `viewBox="0 0 ${round(newWidth)} ${round(newHeight)}"`,
  )
  out = out.replace(rootTag, newRoot)

  return out
}
