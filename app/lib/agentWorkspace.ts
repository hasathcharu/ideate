import type { FileKind } from './tree'

export const AGENT_MAX_MANIFEST_FILES = 500
export const AGENT_MAX_SEARCH_BYTES = 2 * 1024 * 1024
export const AGENT_MAX_SEARCH_RESULTS = 200
export const AGENT_MAX_SEARCH_CONTEXT = 5
export const AGENT_MAX_SEARCH_GLOBS = 32
export const AGENT_MAX_SEARCH_RESPONSE_BYTES = 512 * 1024
export const AGENT_MAX_READ_MANY_PATHS = 32
export const AGENT_MAX_READ_MANY_BYTES = 1024 * 1024
export const AGENT_MAX_PATCH_PATHS = 32
export const AGENT_MAX_PATCH_BYTES = 1024 * 1024

export interface SearchDocument {
  path: string
  text: string
  revision: number
}

export interface SearchMatch {
  path: string
  line: number
  excerpt: string
  revision: number
}

export interface SearchOutput {
  matches: SearchMatch[]
  scannedBytes: number
  truncated: boolean
}

function globExpression(glob: string): RegExp {
  let source = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1
        source += '.*'
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else source += char.replace(/[\\^$.[\]{}()+|]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

export function matchesPathGlobs(path: string, globs: readonly string[]): boolean {
  validateGlobs(globs)
  return globs.length === 0 || globs.some((glob) => globExpression(glob).test(path))
}

function validateGlobs(globs: readonly string[]): void {
  if (globs.length > AGENT_MAX_SEARCH_GLOBS || globs.some((glob) => glob.length > 256)) {
    throw new Error(`globs accepts at most ${AGENT_MAX_SEARCH_GLOBS} patterns of 256 characters each.`)
  }
}

export function searchDocuments(
  documents: readonly SearchDocument[],
  query: string,
  options: { globs?: readonly string[]; caseSensitive?: boolean; contextLines?: number; limit?: number } = {},
): SearchOutput {
  if (!query) throw new Error('query is empty — literal search needs at least one character.')
  const globs = options.globs ?? []
  const context = Math.max(0, Math.min(options.contextLines ?? 0, AGENT_MAX_SEARCH_CONTEXT))
  const limit = Math.max(1, Math.min(options.limit ?? 50, AGENT_MAX_SEARCH_RESULTS))
  const needle = options.caseSensitive ? query : query.toLocaleLowerCase()
  const matches: SearchMatch[] = []
  let scannedBytes = 0
  let responseBytes = 0
  let truncated = false

  validateGlobs(globs)

  outer: for (const document of documents) {
    if (!matchesPathGlobs(document.path, globs)) continue
    const bytes = new TextEncoder().encode(document.text).byteLength
    if (scannedBytes + bytes > AGENT_MAX_SEARCH_BYTES) {
      truncated = true
      break
    }
    scannedBytes += bytes
    const lines = document.text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const haystack = options.caseSensitive ? lines[index]! : lines[index]!.toLocaleLowerCase()
      if (!haystack.includes(needle)) continue
      const from = Math.max(0, index - context)
      const to = Math.min(lines.length, index + context + 1)
      const excerpt = lines.slice(from, to).map((line, offset) => `${from + offset + 1}: ${line}`).join('\n')
      const resultBytes = new TextEncoder().encode(document.path + excerpt).byteLength
      if (responseBytes + resultBytes > AGENT_MAX_SEARCH_RESPONSE_BYTES) {
        truncated = true
        break outer
      }
      responseBytes += resultBytes
      matches.push({
        path: document.path,
        line: index + 1,
        excerpt,
        revision: document.revision,
      })
      if (matches.length >= limit) {
        truncated = index + 1 < lines.length || document !== documents[documents.length - 1]
        break outer
      }
    }
  }
  return { matches, scannedBytes, truncated }
}

export function lineRange(text: string, startLine?: number, endLine?: number): {
  text: string; startLine: number; endLine: number; lineCount: number
} {
  const lines = text === '' ? [] : text.split('\n')
  const lineCount = lines.length
  const start = startLine ?? 1
  const end = endLine ?? lineCount
  if (!Number.isInteger(start) || start < 1) throw new Error('startLine must be a positive integer.')
  if (!Number.isInteger(end) || end < start) throw new Error('endLine must be an integer at or after startLine.')
  if (lineCount === 0) return { text: '', startLine: 1, endLine: 0, lineCount: 0 }
  if (start > lineCount) throw new Error(`startLine ${start} is past the document's ${lineCount} lines.`)
  const boundedEnd = Math.min(end, lineCount)
  return { text: lines.slice(start - 1, boundedEnd).join('\n'), startLine: start, endLine: boundedEnd, lineCount }
}

interface PatchHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

export interface ParsedFilePatch {
  path: string
  oldPath: string | null
  hunks: PatchHunk[]
  newNoNewline: boolean
}

function cleanPatchPath(raw: string): string | null {
  const path = raw.split('\t', 1)[0]!.trim()
  if (path === '/dev/null') return null
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path
}

/** Parse the deliberately small patch language accepted by Agent Link. */
export function parseUnifiedDiff(diff: string): ParsedFilePatch[] {
  if (!diff.trim()) throw new Error('patch is empty.')
  if (new TextEncoder().encode(diff).byteLength > AGENT_MAX_PATCH_BYTES) {
    throw new Error(`patch exceeds the ${AGENT_MAX_PATCH_BYTES}-byte limit.`)
  }
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const files: ParsedFilePatch[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.startsWith('rename from ') || line.startsWith('rename to ') || line.startsWith('deleted file mode ')) {
      throw new Error('patches cannot rename or delete files.')
    }
    if (!line.startsWith('--- ')) { index += 1; continue }
    const oldPath = cleanPatchPath(line.slice(4))
    const plus = lines[index + 1]
    if (!plus?.startsWith('+++ ')) throw new Error('each --- header must be followed by a +++ header.')
    const path = cleanPatchPath(plus.slice(4))
    if (path === null) throw new Error('patches cannot delete files.')
    if (oldPath !== null && oldPath !== path) throw new Error('patches cannot rename files.')
    index += 2
    const hunks: PatchHunk[] = []
    let newNoNewline = false
    while (index < lines.length && !lines[index]!.startsWith('--- ')) {
      if (lines[index]!.startsWith('diff --git ')) { index += 1; continue }
      if (!lines[index]!.startsWith('@@ ')) { index += 1; continue }
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]!)
      if (!header) throw new Error(`invalid hunk header: ${lines[index]}`)
      const hunk: PatchHunk = {
        oldStart: Number(header[1]), oldCount: Number(header[2] ?? '1'),
        newStart: Number(header[3]), newCount: Number(header[4] ?? '1'), lines: [],
      }
      index += 1
      let oldSeen = 0
      let newSeen = 0
      while (index < lines.length && (oldSeen < hunk.oldCount || newSeen < hunk.newCount)) {
        const body = lines[index]!
        if (body === '\\ No newline at end of file') {
          const previous = hunk.lines[hunk.lines.length - 1]
          if (previous?.[0] === '-') newNoNewline = false
          else if (previous) newNoNewline = true
          index += 1
          continue
        }
        if (body === '' && index === lines.length - 1) { index += 1; break }
        if (![' ', '+', '-'].includes(body[0] ?? '')) throw new Error(`invalid hunk line: ${body}`)
        hunk.lines.push(body)
        if (body[0] !== '+') oldSeen += 1
        if (body[0] !== '-') newSeen += 1
        index += 1
      }
      if (lines[index] === '\\ No newline at end of file') {
        const previous = hunk.lines[hunk.lines.length - 1]
        if (previous?.[0] === '-') newNoNewline = false
        else if (previous) newNoNewline = true
        index += 1
      }
      if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) {
        throw new Error(`hunk count mismatch for ${path}: expected ${hunk.oldCount}/${hunk.newCount}, got ${oldSeen}/${newSeen}.`)
      }
      hunks.push(hunk)
    }
    if (hunks.length === 0) throw new Error(`patch for ${path} contains no hunks.`)
    files.push({ path, oldPath, hunks, newNoNewline })
  }
  if (files.length === 0) throw new Error('patch contains no file headers.')
  if (files.length > AGENT_MAX_PATCH_PATHS) throw new Error(`patch touches more than ${AGENT_MAX_PATCH_PATHS} files.`)
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error('each path may appear only once in a patch.')
  return files
}

export interface AppliedPatch {
  text: string
  added: number
  deleted: number
}

export class PatchHunkError extends Error {
  constructor(readonly line: number, readonly excerpt: string, message: string) { super(message) }
}

export function applyFilePatch(text: string, patch: ParsedFilePatch): AppliedPatch {
  const trailingNewline = text.endsWith('\n')
  const input = text === '' ? [] : text.split('\n')
  if (trailingNewline) input.pop()
  const output: string[] = []
  let cursor = 0
  let added = 0
  let deleted = 0
  for (const hunk of patch.hunks) {
    const target = Math.max(0, hunk.oldStart - 1)
    if (target < cursor || target > input.length) throw new PatchHunkError(hunk.oldStart, excerptAt(input, target), 'hunk position is outside the current document.')
    output.push(...input.slice(cursor, target))
    let probe = target
    for (const entry of hunk.lines) {
      const prefix = entry[0]!
      const body = entry.slice(1)
      if (prefix === '+') { output.push(body); added += 1; continue }
      if (input[probe] !== body) {
        const occurrences = input.reduce<number[]>((found, line, at) => line === body ? [...found, at] : found, [])
        const reason = occurrences.length > 1 ? 'hunk is ambiguous against the current document.' : 'hunk context does not match the current document.'
        throw new PatchHunkError(probe + 1, excerptAt(input, probe), reason)
      }
      if (prefix === ' ') output.push(body)
      else deleted += 1
      probe += 1
    }
    cursor = probe
  }
  output.push(...input.slice(cursor))
  const last = patch.hunks[patch.hunks.length - 1]!
  const touchesEnd = Math.max(0, last.oldStart - 1) + last.oldCount === input.length
  const nextHasNewline = touchesEnd ? !patch.newNoNewline : trailingNewline
  const next = output.join('\n') + (nextHasNewline && output.length > 0 ? '\n' : '')
  return { text: next, added, deleted }
}

function excerptAt(lines: readonly string[], at: number): string {
  const from = Math.max(0, at - 2)
  const to = Math.min(lines.length, at + 3)
  return lines.slice(from, to).map((line, offset) => `${from + offset + 1}: ${line}`).join('\n')
}

export function assertPatchableKind(path: string, kind: FileKind): void {
  if (kind === 'excalidraw') throw new Error(`${path} is a scene; use ideate_scene_edit instead of patching its JSON.`)
}
