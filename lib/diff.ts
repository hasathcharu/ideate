/**
 * Line diffs, for showing what is uncommitted.
 *
 * The app already holds both sides of the comparison — the committed content it
 * loaded (`baseline`) and the working copy in the editor — so a diff needs no
 * GitHub call at all; only an algorithm. This is that algorithm, plus the
 * grouping into hunks that makes the result readable the way GitHub's file view
 * is readable.
 *
 * The core is Myers' O((N+M)D) diff, which is what git itself uses by default.
 * Two guards keep it honest on real documents:
 *
 * - A **common prefix and suffix trim** first. Editing three lines of a
 *   500-line document leaves Myers a handful of lines to work on rather than
 *   1000, which is the difference between instant and noticeable.
 * - A **size cap** on what's left. Past it (two large, wholly different files)
 *   the diff degrades to "all of the old, then all of the new" rather than
 *   spending seconds and hundreds of megabytes proving the obvious.
 */

/** Beyond this many differing lines, fall back to a whole-file replacement. The
 *  trace Myers keeps costs O(D²) memory, and a diff this large is unreadable
 *  anyway. */
const MAX_DIFF_LINES = 6000

export type DiffLineType = 'context' | 'add' | 'remove'

export interface DiffLine {
  type: DiffLineType
  text: string
  /** 1-based line number on the committed side; null for an added line. */
  oldNumber: number | null
  /** 1-based line number in the working copy; null for a removed line. */
  newNumber: number | null
}

/** A run of changed lines plus its surrounding context — one `@@` block. */
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  hunks: DiffHunk[]
  additions: number
  deletions: number
  /** True when the two sides are identical (no hunks, nothing to show). */
  unchanged: boolean
  /** True when the size cap forced the whole-file fallback. */
  truncated: boolean
}

/** Lines of a document, with the trailing newline's empty last line dropped —
 *  otherwise every file appears to end with a blank line that isn't there. */
function splitLines(text: string): string[] {
  // An empty document has *no* lines, not one empty one — otherwise a new file
  // opens its diff with a phantom removed blank line.
  if (text === '') return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

interface Edit {
  type: DiffLineType
  text: string
}

/**
 * Myers' shortest edit script between two line arrays.
 *
 * `trace` holds the furthest-reaching path for every edit distance `d` *before*
 * that round runs, which is what the backtrack pass needs to walk the path back
 * out again.
 */
function myers(a: string[], b: string[]): Edit[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  if (max > MAX_DIFF_LINES) return null

  const offset = max
  let v = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      // Extend whichever neighbouring path reaches further: down (an insertion
      // from k+1) or right (a deletion from k-1).
      let x: number
      if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
        x = v[k + 1 + offset]!
      } else {
        x = v[k - 1 + offset]! + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[k + offset] = x
      if (x >= n && y >= m) return backtrack(trace, a, b, offset)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): Edit[] {
  const reversed: Edit[] = []
  let x = a.length
  let y = b.length

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) prevK = k + 1
    else prevK = k - 1
    const prevX = v[prevK + offset]!
    const prevY = prevX - prevK

    // Diagonal moves are matching lines.
    while (x > prevX && y > prevY) {
      reversed.push({ type: 'context', text: a[x - 1]! })
      x--
      y--
    }
    if (d === 0) break
    if (x === prevX) {
      reversed.push({ type: 'add', text: b[y - 1]! })
      y--
    } else {
      reversed.push({ type: 'remove', text: a[x - 1]! })
      x--
    }
  }

  reversed.reverse()
  return reversed
}

/** Every line of the comparison, in order, numbered on both sides. */
export function diffLines(before: string, after: string): { lines: DiffLine[]; truncated: boolean } {
  const a = splitLines(before)
  const b = splitLines(after)

  // Trim the identical head and tail, so Myers only sees the part that differs.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const middleA = a.slice(head, a.length - tail)
  const middleB = b.slice(head, b.length - tail)
  const edits = myers(middleA, middleB)
  const truncated = edits === null
  const middle: Edit[] =
    edits ??
    // Fallback: the whole middle, removed then added.
    [
      ...middleA.map((text): Edit => ({ type: 'remove', text })),
      ...middleB.map((text): Edit => ({ type: 'add', text })),
    ]

  const script: Edit[] = [
    ...a.slice(0, head).map((text): Edit => ({ type: 'context', text })),
    ...middle,
    ...a.slice(a.length - tail).map((text): Edit => ({ type: 'context', text })),
  ]

  let oldNumber = 0
  let newNumber = 0
  const lines = script.map((edit): DiffLine => {
    if (edit.type === 'add') return { ...edit, oldNumber: null, newNumber: ++newNumber }
    if (edit.type === 'remove') return { ...edit, oldNumber: ++oldNumber, newNumber: null }
    return { ...edit, oldNumber: ++oldNumber, newNumber: ++newNumber }
  })
  return { lines, truncated }
}

/**
 * Group changed lines into hunks with `context` unchanged lines around them,
 * merging two changes that are close enough to share context — the same shape as
 * a unified diff's `@@` blocks.
 */
export function buildHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const changed = lines
    .map((line, index) => (line.type === 'context' ? -1 : index))
    .filter((index) => index >= 0)
  if (changed.length === 0) return []

  const ranges: Array<[number, number]> = []
  for (const index of changed) {
    const start = Math.max(0, index - context)
    const end = Math.min(lines.length - 1, index + context)
    const last = ranges[ranges.length - 1]
    // Touching or overlapping windows become one hunk, so two nearby edits don't
    // repeat the lines between them.
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  }

  return ranges.map(([start, end]) => {
    const slice = lines.slice(start, end + 1)
    const oldNumbers = slice.map((l) => l.oldNumber).filter((n): n is number => n !== null)
    const newNumbers = slice.map((l) => l.newNumber).filter((n): n is number => n !== null)
    return {
      oldStart: oldNumbers[0] ?? 0,
      oldLines: oldNumbers.length,
      newStart: newNumbers[0] ?? 0,
      newLines: newNumbers.length,
      lines: slice,
    }
  })
}

/** The full comparison of one file: hunks plus the `+`/`−` counts. */
export function diffFile(before: string, after: string, context = 3): FileDiff {
  const { lines, truncated } = diffLines(before, after)
  const additions = lines.filter((l) => l.type === 'add').length
  const deletions = lines.filter((l) => l.type === 'remove').length
  return {
    hunks: buildHunks(lines, context),
    additions,
    deletions,
    unchanged: additions === 0 && deletions === 0,
    truncated,
  }
}

/* ------------------------------------------------------------------ */
/* Change blocks (the editor's dirty gutter, and its peek popup)        */
/* ------------------------------------------------------------------ */

/**
 * What happened to one line of the working copy, relative to what was committed:
 * it is new, it replaced a committed line, or committed lines were deleted
 * immediately above it.
 */
export type LineChangeKind = 'added' | 'modified' | 'removed'

/**
 * One run of adjacent changed lines — what the gutter marks and what the peek
 * popup shows.
 *
 * A block, rather than a line, is the unit here for the same reason VS Code uses
 * one: the three states only mean anything when a run of edits is read as a
 * whole. Removals *and* additions together are a **modification**; additions
 * alone are an **addition**; removals alone leave nothing in the working copy to
 * mark, so the marker lands on the line that now sits where they were.
 */
export interface LineChangeBlock {
  kind: LineChangeKind
  /** Every line of the run, both sides, in order — the peek popup's content. */
  lines: DiffLine[]
  /** Working-copy line numbers this block is marked against. */
  anchors: number[]
  /** How to put the committed text back — see {@link LineChangeRevert}. */
  revert: LineChangeRevert
}

/**
 * A revert, expressed as "replace these working-copy lines with this text".
 *
 * One shape covers all three kinds, which is the point: the editor applies it
 * without re-deriving what sort of change it was.
 *
 * - **Modified** — replace the block's lines with the committed ones.
 * - **Added** — same range, empty text (the line break goes with it).
 * - **Deleted** — an insertion: `toLine` is `fromLine - 1`, an empty range, and
 *   `fromLine` is the line the committed text goes back in front of (one past the
 *   last line when the deletion ran to the end of the file).
 */
export interface LineChangeRevert {
  /** First 1-based working-copy line to replace. */
  fromLine: number
  /** Last line to replace; `fromLine - 1` for a pure insertion. */
  toLine: number
  /** The committed text for those lines, `''` to delete them. */
  text: string
}

/** Split a line-by-line diff into its runs of changed lines. */
function changeBlocks(lines: DiffLine[]): LineChangeBlock[] {
  const blocks: LineChangeBlock[] = []
  /** Last line number seen on the working-copy side, for a deletion at EOF. */
  let lastNewNumber = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.type === 'context') {
      lastNewNumber = line.newNumber ?? lastNewNumber
      continue
    }

    let end = i
    let added = 0
    let removed = 0
    while (end < lines.length && lines[end]!.type !== 'context') {
      if (lines[end]!.type === 'add') added++
      else removed++
      end++
    }

    const run = lines.slice(i, end)
    const kind: LineChangeKind = added === 0 ? 'removed' : removed > 0 ? 'modified' : 'added'
    const committed = run
      .filter((line) => line.type === 'remove')
      .map((line) => line.text)
      .join('\n')
    const anchors: number[] = []
    let revert: LineChangeRevert
    if (added === 0) {
      // Pure deletion: anchor on the following line, or on the last line when the
      // deletion ran to the end of the document.
      const following = lines[end]?.newNumber ?? null
      const next = following ?? lastNewNumber
      if (next > 0) anchors.push(next)
      // Putting it back is an insertion — before the following line, or after the
      // last one when there is no following line.
      const insertAt = following ?? lastNewNumber + 1
      revert = { fromLine: insertAt, toLine: insertAt - 1, text: committed }
    } else {
      for (const changed of run) {
        if (changed.newNumber !== null) {
          anchors.push(changed.newNumber)
          lastNewNumber = changed.newNumber
        }
      }
      revert = {
        fromLine: anchors[0] ?? 1,
        toLine: anchors[anchors.length - 1] ?? 1,
        text: committed,
      }
    }

    if (anchors.length > 0) blocks.push({ kind, lines: run, anchors, revert })
    i = end - 1
  }

  return blocks
}

/**
 * Change markers for the editor gutter, keyed by **1-based line number in the
 * working copy** — the numbers CodeMirror can actually put a marker beside.
 */
export function lineChanges(before: string, after: string): Map<number, LineChangeKind> {
  const marks = new Map<number, LineChangeKind>()
  for (const block of changeBlocks(diffLines(before, after).lines)) {
    for (const anchor of block.anchors) {
      // A line already marked by an earlier block keeps that mark: an insertion
      // or modification is the more specific statement about the line itself,
      // where a deletion marker only says something was removed beside it.
      if (!marks.has(anchor) || block.kind !== 'removed') marks.set(anchor, block.kind)
    }
  }
  return marks
}

/** The change block marked against `line` of the working copy, if any — what the
 *  gutter's peek popup shows when that marker is clicked. */
export function changeAtLine(
  before: string,
  after: string,
  line: number,
): LineChangeBlock | null {
  const blocks = changeBlocks(diffLines(before, after).lines)
  return blocks.find((block) => block.anchors.includes(line)) ?? null
}

/* ------------------------------------------------------------------ */
/* Side-by-side rows                                                   */
/* ------------------------------------------------------------------ */

/** One row of a side-by-side diff. Either side may be empty, where the other
 *  side has a line it has nothing to pair with. */
export interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
}

/**
 * Re-shape a run of unified diff lines into aligned left/right rows.
 *
 * Removed and added lines within one run are paired positionally, so a changed
 * line sits opposite the line it replaced — which is the whole point of reading a
 * diff side by side. Whichever side runs out first pads with blanks.
 */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.type === 'context') {
      rows.push({ left: line, right: line })
      continue
    }
    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    let end = i
    while (end < lines.length && lines[end]!.type !== 'context') {
      if (lines[end]!.type === 'add') added.push(lines[end]!)
      else removed.push(lines[end]!)
      end++
    }
    for (let j = 0; j < Math.max(removed.length, added.length); j++) {
      rows.push({ left: removed[j] ?? null, right: added[j] ?? null })
    }
    i = end - 1
  }
  return rows
}
