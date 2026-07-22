/**
 * Soften beautiful-mermaid's orthogonal (right-angle) edge routing.
 *
 * The layout engine (ELK, bundled inside beautiful-mermaid and not configurable
 * through its public options) routes flowchart / state edges as `<polyline>`s
 * with sharp 90° corners — the "squary" look. We can't swap the engine, but we
 * can rewrite each edge polyline into a `<path>` whose corners are rounded with
 * quadratic curves. Straight approaches into the nodes are preserved, so arrow
 * heads (marker-end/-start) still point the right way.
 *
 * Deterministic string rewrite (no DOM) → safe during SSR. Any parse failure
 * leaves that edge untouched.
 */

/** Corner radius in px; capped per-corner to half the shorter adjacent segment. */
const CORNER_RADIUS = 12

const round = (n: number) => Math.round(n * 1000) / 1000

interface Pt {
  x: number
  y: number
}

function parsePoints(str: string): Pt[] {
  return str
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',')
      return { x: parseFloat(x!), y: parseFloat(y!) }
    })
    .filter((p) => isFinite(p.x) && isFinite(p.y))
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/** A point `d` away from `from`, heading toward `to`. */
function along(from: Pt, to: Pt, d: number): Pt {
  const len = dist(from, to) || 1
  return { x: from.x + ((to.x - from.x) / len) * d, y: from.y + ((to.y - from.y) / len) * d }
}

/** Build a path with rounded corners through the given polyline points. */
function roundedPath(pts: Pt[], radius: number): string {
  let d = `M ${round(pts[0]!.x)} ${round(pts[0]!.y)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!
    const cur = pts[i]!
    const next = pts[i + 1]!
    const r = Math.min(radius, dist(prev, cur) / 2, dist(cur, next) / 2)
    if (r <= 0.5) {
      // Degenerate corner (collinear or zero-length) — keep it sharp.
      d += ` L ${round(cur.x)} ${round(cur.y)}`
      continue
    }
    const enter = along(cur, prev, r)
    const exit = along(cur, next, r)
    d += ` L ${round(enter.x)} ${round(enter.y)} Q ${round(cur.x)} ${round(cur.y)} ${round(exit.x)} ${round(exit.y)}`
  }
  const last = pts[pts.length - 1]!
  d += ` L ${round(last.x)} ${round(last.y)}`
  return d
}

/** Round the corners of every `<polyline class="edge" …>` in the SVG. */
export function smoothEdges(svg: string): string {
  if (!svg.includes('class="edge"')) return svg
  return svg.replace(/<polyline class="edge"[^>]*\/>/g, (tag) => {
    try {
      const m = tag.match(/points="([^"]*)"/)
      if (!m) return tag
      const pts = parsePoints(m[1]!)
      if (pts.length < 3) return tag // straight line — nothing to round
      const d = roundedPath(pts, CORNER_RADIUS)
      return tag
        .replace(/^<polyline/, '<path')
        .replace(/\s*points="[^"]*"/, '')
        .replace(/\s*\/>\s*$/, ` d="${d}" />`)
    } catch {
      return tag
    }
  })
}
