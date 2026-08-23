import type { TextEdit } from './agentProtocol'

/**
 * Turning anchored replacements into concrete document ranges.
 *
 * Pure: no React, no CodeMirror, no I/O — same discipline as `lib/diff.ts`. Two
 * callers need it and neither can own it. `Editor` resolves against its live
 * document and dispatches the result as one transaction; the bridge falls back to
 * resolving against the plain text and calling `setText` when no editor is mounted
 * (a scene is open, or the diff view has taken the pane).
 *
 * Every range is resolved against the *original* document before any is applied.
 * That is what makes a batch atomic: CodeMirror maps a whole `ChangeSet` from the
 * pre-transaction document, and `applyResolved` walks the same offsets backwards,
 * so neither has to reason about earlier edits shifting later ones.
 */

export interface ResolvedChange {
  from: number
  to: number
  insert: string
}

/**
 * Resolve each edit to a range, or throw explaining which one failed and why.
 *
 * Throwing rather than reporting per-edit success is deliberate: a half-applied
 * batch leaves the document in a state neither the agent nor the user asked for,
 * and the agent's next edit would then be anchored against text it never saw.
 * Failing whole means the document is always either fully updated or untouched.
 */
export function resolveEdits(doc: string, edits: readonly TextEdit[]): ResolvedChange[] {
  if (edits.length === 0) throw new Error('No edits given.')

  const changes: ResolvedChange[] = []

  for (const [index, edit] of edits.entries()) {
    const label = `edit ${index + 1}`
    // An empty anchor matches at every position, so "replace nothing with
    // something" would insert the text throughout the document.
    if (edit.oldText === '') {
      throw new Error(`${label}: oldText is empty. Anchor the edit on text that exists.`)
    }

    const found = occurrences(doc, edit.oldText)
    if (found.length === 0) {
      throw new Error(
        `${label}: oldText not found in the document. ` +
          `Read the document again — it may have changed since you last saw it. ` +
          `Looking for: ${preview(edit.oldText)}`,
      )
    }
    if (found.length > 1 && !edit.replaceAll) {
      throw new Error(
        `${label}: oldText matches ${found.length} places. ` +
          `Include more surrounding text to make it unique, or pass replaceAll. ` +
          `Looking for: ${preview(edit.oldText)}`,
      )
    }

    for (const from of edit.replaceAll ? found : [found[0]!]) {
      changes.push({ from, to: from + edit.oldText.length, insert: edit.newText })
    }
  }

  changes.sort((a, b) => a.from - b.from)

  // CodeMirror throws on an overlapping ChangeSet, and it would throw from inside
  // `dispatch` with nothing pointing at which pair of edits collided. Two edits
  // whose anchors overlap almost always means the second was written against the
  // result of the first, so say that.
  for (let i = 1; i < changes.length; i++) {
    const previous = changes[i - 1]!
    const current = changes[i]!
    if (current.from < previous.to) {
      throw new Error(
        'Two edits touch overlapping text. Each edit is anchored against the ' +
          'document as it is now, not against the result of the earlier edits in ' +
          'the same call — combine them into one edit instead.',
      )
    }
  }

  return changes
}

/** Apply resolved ranges to a plain string. Walks backwards so earlier offsets
 *  stay valid as later text is spliced out. */
export function applyResolved(doc: string, changes: readonly ResolvedChange[]): string {
  let out = doc
  for (let i = changes.length - 1; i >= 0; i--) {
    const { from, to, insert } = changes[i]!
    out = out.slice(0, from) + insert + out.slice(to)
  }
  return out
}

function occurrences(doc: string, needle: string): number[] {
  const found: number[] = []
  let at = doc.indexOf(needle)
  while (at !== -1) {
    found.push(at)
    // Step past the whole match: overlapping matches of the same anchor would
    // resolve to overlapping ranges, which the check above would then reject.
    at = doc.indexOf(needle, at + needle.length)
  }
  return found
}

/** A short, single-line rendering of an anchor, for error messages. The full text
 *  can be an entire function and is already in the agent's own request. */
function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 60 ? `"${oneLine.slice(0, 60)}…"` : `"${oneLine}"`
}
