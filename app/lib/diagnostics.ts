import type { Diagnostic, DocKind } from './agentProtocol'
import type { MermaidUserConfig } from './mermaidConfig'
import { parseDiagram } from './mermaid'

/**
 * What the renderer thinks of the document, reported back to the agent after
 * every edit.
 *
 * This is the reason the bridge exists at all. An agent editing files on disk
 * writes a diagram, and finds out whether it parses when a human opens it. An
 * agent editing through the live editor gets mermaid's own verdict in the result
 * of its own tool call, and can fix its mistake in the same turn.
 */

/** One ` ```mermaid ` fence found in a markdown document. */
interface Fence {
  /** 1-based line of the opening fence, so a diagnostic points somewhere. */
  line: number
  source: string
}

export async function collectDiagnostics(
  text: string,
  kind: DocKind,
  config: MermaidUserConfig | null,
): Promise<Diagnostic[]> {
  // A scene is JSON on a canvas — there is no renderer to have an opinion, and a
  // malformed one fails at `parseScene` long before this.
  if (kind === 'excalidraw') return []

  if (kind === 'mermaid') {
    const result = await parseDiagram(text, config)
    return result.ok ? [] : [{ label: null, message: result.message }]
  }

  const fences = mermaidFences(text)
  const diagnostics: Diagnostic[] = []
  // Sequentially, not `Promise.all`: mermaid re-`initialize()`s one global
  // instance, so overlapping parses race with nothing to gain (the same reason
  // `MarkdownPreview` renders its diagrams in series).
  for (const [index, fence] of fences.entries()) {
    const result = await parseDiagram(fence.source, config)
    if (!result.ok) {
      diagnostics.push({
        label: `mermaid block ${index + 1} (line ${fence.line})`,
        message: result.message,
      })
    }
  }
  return diagnostics
}

/**
 * Every ` ```mermaid ` fence in a markdown document.
 *
 * Line-based rather than one regex: a fence can be indented (inside a list item
 * or a blockquote) and can be opened with more than three backticks, and its
 * closing fence has to match the opener's length. A regex that got all three
 * right would be less readable than this loop, and one that got them wrong would
 * silently skip exactly the fences most likely to be malformed.
 */
function mermaidFences(text: string): Fence[] {
  const lines = text.split('\n')
  const fences: Fence[] = []

  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,})\s*mermaid\b.*$/.exec(lines[i]!)
    if (!open) continue

    const indent = open[1]!.length
    const ticks = open[2]!.length
    const start = i + 1

    let end = start
    while (end < lines.length && !isClosing(lines[end]!, ticks)) end++

    fences.push({
      line: i + 1,
      // Strip the fence's own indentation, or an indented diagram reaches mermaid
      // with leading whitespace on every line.
      source: lines
        .slice(start, end)
        .map((line) => stripIndent(line, indent))
        .join('\n'),
    })

    // Resume after the closing fence, so a diagram whose body happens to contain
    // the word "mermaid" can't be mistaken for a second block.
    i = end
  }

  return fences
}

function isClosing(line: string, ticks: number): boolean {
  const match = /^\s*(`{3,})\s*$/.exec(line)
  return match !== null && match[1]!.length >= ticks
}

function stripIndent(line: string, indent: number): string {
  let cut = 0
  while (cut < indent && (line[cut] === ' ' || line[cut] === '\t')) cut++
  return line.slice(cut)
}
