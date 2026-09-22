/** Find-in-page over a rendered markdown document. */

/** Elements whose text is a block of its own. Used to stop a match running from
 *  the end of one block into the start of the next: the DOM has no whitespace
 *  between `<p>foo</p>` and `<p>bar</p>`, so a naive concatenation reads
 *  "foobar" and would happily match "oob" across the gap. */
const BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, figcaption, summary, dt, dd'

/** Ceiling on matches per query. A one-character query in a long document is
 *  thousands of ranges, all of which the highlight registry then has to paint on
 *  every scroll — and nobody navigates a list that long anyway. */
const MAX_MATCHES = 500

/** A text node's span within the flattened document text. */
interface Segment {
  node: Text
  start: number
  length: number
}

/** Flatten `root`'s visible text, remembering where each text node landed. */
function flatten(root: HTMLElement): { text: string; segments: Segment[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      // A rendered diagram's labels are laid out by mermaid inside a transformed,
      // zoomable SVG. A highlight rectangle over one lands wherever the current
      // pan and zoom put it, which is not where the reader is looking.
      if (parent.closest('svg')) return NodeFilter.FILTER_REJECT
      // The copy button's glyphs carry no text, but its accessible label would
      // otherwise be matchable; rejecting the whole control is simpler than
      // reasoning about which parts of it are readable.
      if (parent.closest('.md-copy-button')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  const segments: Segment[] = []
  let text = ''
  let previousBlock: Element | null = null

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text
    const value = textNode.nodeValue ?? ''
    if (!value) continue
    const block = textNode.parentElement?.closest(BLOCK_SELECTOR) ?? null
    if (segments.length > 0 && block !== previousBlock) text += '\n'
    previousBlock = block
    segments.push({ node: textNode, start: text.length, length: value.length })
    text += value
  }

  return { text, segments }
}

/**
 * The segment containing `offset`. `atEnd` picks the segment a boundary belongs to when it falls
 * exactly between two of them: a match's start belongs to the segment that begins there, its end to
 * the one that finishes there.
 */
function segmentAt(segments: Segment[], offset: number, atEnd: boolean): Segment | null {
  let low = 0
  let high = segments.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const segment = segments[mid]!
    const from = segment.start
    const to = segment.start + segment.length
    const before = atEnd ? offset <= from : offset < from
    const after = atEnd ? offset > to : offset >= to
    if (before) high = mid - 1
    else if (after) low = mid + 1
    else return segment
  }
  return null
}

/** Every occurrence of `query` inside `root`, in document order, as live ranges. */
export function findRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase()
  if (!needle.trim()) return []

  const { text, segments } = flatten(root)
  const haystack = text.toLowerCase()
  const ranges: Range[] = []

  let from = 0
  while (ranges.length < MAX_MATCHES) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    // Advance past this hit whatever happens below, so a match that cannot be
    // turned into a range can never spin the loop.
    from = at + Math.max(1, needle.length)

    const startSegment = segmentAt(segments, at, false)
    const endSegment = segmentAt(segments, at + needle.length, true)
    if (!startSegment || !endSegment) continue

    const range = document.createRange()
    range.setStart(startSegment.node, at - startSegment.start)
    range.setEnd(endSegment.node, at + needle.length - endSegment.start)
    ranges.push(range)
  }

  return ranges
}

/** Highlight registry names. Two, because the match you are on has to look
 *  different from the ones you are not on. */
export const FIND_HIGHLIGHT = 'md-find'
export const FIND_ACTIVE_HIGHLIGHT = 'md-find-active'

function highlights(): HighlightRegistry | null {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return null
  return CSS.highlights
}

/** Paint `ranges`, with `active` picked out. Both registries are always written,
 *  so clearing is just calling this with an empty list. */
export function paintFindHighlights(ranges: Range[], active: Range | null): void {
  const registry = highlights()
  if (!registry) return
  if (ranges.length === 0) {
    registry.delete(FIND_HIGHLIGHT)
    registry.delete(FIND_ACTIVE_HIGHLIGHT)
    return
  }
  registry.set(FIND_HIGHLIGHT, new Highlight(...ranges))
  if (active) registry.set(FIND_ACTIVE_HIGHLIGHT, new Highlight(active))
  else registry.delete(FIND_ACTIVE_HIGHLIGHT)
}

/** Drop every find highlight — on close, and on unmount. Leaving them set would
 *  keep painting ranges into a document nobody is searching. */
export function clearFindHighlights(): void {
  const registry = highlights()
  if (!registry) return
  registry.delete(FIND_HIGHLIGHT)
  registry.delete(FIND_ACTIVE_HIGHLIGHT)
}

/** Scroll `container` so `range` sits `offset` px below its top edge. Measured
 *  rather than `scrollIntoView`, which on a nested scroller also nudges the
 *  window — the same trap the heading and line-sync scrolls avoid. */
export function scrollRangeIntoView(
  container: HTMLElement,
  range: Range,
  offset: number,
): void {
  const rect = range.getBoundingClientRect()
  // A range inside a collapsed or not-yet-laid-out subtree measures as zero on
  // every axis, and scrolling to it would jump to the top of the document.
  if (rect.height === 0 && rect.width === 0) return
  const containerRect = container.getBoundingClientRect()
  const top = rect.top - containerRect.top + container.scrollTop - offset
  // Already comfortably in view: re-scrolling would twitch the page on every
  // keystroke of a query that keeps matching the same place.
  const relative = rect.top - containerRect.top
  if (relative >= offset && relative <= containerRect.height - offset) return
  container.scrollTo({ top: Math.max(0, top) })
}
