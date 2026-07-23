import { load, YAMLException } from 'js-yaml'

/**
 * The user-editable mermaid config (the cogwheel next to the layout dropdown).
 *
 * mermaid diagrams are normally tuned with a YAML frontmatter block:
 *
 *   ---
 *   config:
 *     theme: base
 *     themeVariables: { primaryColor: '#e5e9f0', ... }
 *     sequence: { actorMargin: 50 }
 *   ---
 *   flowchart TD
 *     ...
 *
 * Here we lift that same object out of the diagram and make it a single *global*
 * config that applies to every render (via `mermaid.initialize`, see lib/mermaid.ts)
 * and — for anything under `themeVariables` — to the whole app chrome as well
 * (see `applyThemeToSite`). The stored value is the raw YAML text; parsing is
 * tolerant so a half-typed config never breaks the preview.
 */

/** Result of parsing the user's YAML config text. */
export interface ParsedConfig {
  /** The parsed config object (never null on success), or null if invalid/empty. */
  config: MermaidUserConfig | null
  /** Human-readable parse error, or null when the text is valid (or empty). */
  error: string | null
}

/** A loosely-typed mermaid config object. mermaid validates the individual keys
 *  at initialize time; we only care about the shape enough to read `themeVariables`. */
export type MermaidUserConfig = Record<string, unknown> & {
  theme?: string
  themeVariables?: Record<string, string>
}

/** A commented starter shown as a placeholder when no config has been set yet. */
export const CONFIG_PLACEHOLDER = `# Mermaid config (YAML). Applies to every diagram.
# Anything under themeVariables also recolors the whole app.
config:
  theme: base
  themeVariables:
    primaryColor: '#e5e9f0'
    primaryTextColor: '#2e3440'
    primaryBorderColor: '#5e81ac'
    lineColor: '#5e81ac'
    background: '#eceff4'
    fontFamily: JetBrains Mono
`

/**
 * Parse the user's YAML config text into a plain object.
 *
 * Accepts both a bare config body and a full frontmatter paste: leading/trailing
 * `---` fences are stripped, and a top-level `config:` wrapper (the frontmatter
 * key) is unwrapped so either form works.
 */
export function parseMermaidConfig(yaml: string): ParsedConfig {
  const stripped = stripFrontmatterFences(yaml)
  if (!stripped.trim()) return { config: null, error: null }

  let doc: unknown
  try {
    doc = load(stripped)
  } catch (err) {
    if (err instanceof YAMLException) {
      // js-yaml's messages include a line/column snippet already.
      return { config: null, error: err.reason ? `${err.reason}` : err.message }
    }
    return { config: null, error: err instanceof Error ? err.message : String(err) }
  }

  if (doc == null) return { config: null, error: null }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return { config: null, error: 'Config must be a mapping of keys to values.' }
  }

  // Unwrap the frontmatter `config:` key if the user pasted the whole block.
  const record = doc as Record<string, unknown>
  const unwrapped =
    'config' in record && isPlainObject(record.config)
      ? (record.config as Record<string, unknown>)
      : record

  return { config: unwrapped as MermaidUserConfig, error: null }
}

/** Remove leading/trailing `---` (or `...`) YAML document fences and surrounding
 *  blank lines, so pasting a full mermaid frontmatter block Just Works. */
function stripFrontmatterFences(yaml: string): string {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] ?? '').trim() === '') start++
  if (start < end && /^---\s*$/.test(lines[start] ?? '')) {
    start++
    // Drop the matching closing fence (--- or ...) if there is one.
    for (let i = end - 1; i > start; i--) {
      const line = (lines[i] ?? '').trim()
      if (line === '') continue
      if (/^(---|\.\.\.)$/.test(line)) end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* ------------------------------------------------------------------ */
/* Layout (the dropdown edits the YAML)                               */
/* ------------------------------------------------------------------ */

/** Read the `layout` value from a parsed config, validated against `allowed`. */
export function layoutFromConfig(
  config: MermaidUserConfig | null,
  allowed: readonly string[],
  fallback: string,
): string {
  const value = config?.layout
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/**
 * Set the top-level `layout` key in the raw YAML text, so the layout dropdown
 * can write back into the config that is the single source of truth. Works on
 * the raw string (not a parse → dump round-trip) so user comments, key order,
 * and formatting survive. Handles both the bare-body form (layout at the root)
 * and the frontmatter form (layout nested under a `config:` key), updating an
 * existing key in place or inserting one when absent.
 */
export function setLayoutInYaml(yaml: string, layout: string): string {
  const nl = yaml.includes('\r\n') ? '\r\n' : '\n'
  if (!yaml.trim()) return `layout: ${layout}${nl}`

  const lines = yaml.split(/\r?\n/)
  const indentOf = (line: string): number => (line.match(/^\s*/)?.[0].length ?? 0)

  // Frontmatter form: a top-level `config:` mapping — layout lives under it.
  const configIdx = lines.findIndex((l) => /^config\s*:\s*(#.*)?$/.test(l))
  if (configIdx >= 0) {
    // Detect the child indentation from the first real child line.
    let childIndent = '  '
    for (let i = configIdx + 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '' || /^\s*#/.test(line)) continue
      if (indentOf(line) === 0) break // block has no children
      childIndent = line.match(/^\s*/)?.[0] ?? '  '
      break
    }
    const layoutRe = new RegExp(`^${childIndent}layout\\s*:\\s*\\S*(.*)$`)
    for (let i = configIdx + 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '') continue
      if (indentOf(line) === 0) break // reached the next top-level key / fence
      const m = layoutRe.exec(line)
      if (m) {
        lines[i] = `${childIndent}layout: ${layout}${m[1] ?? ''}`
        return lines.join(nl)
      }
    }
    lines.splice(configIdx + 1, 0, `${childIndent}layout: ${layout}`)
    return lines.join(nl)
  }

  // Bare-body form: layout at the root.
  const rootRe = /^layout\s*:\s*\S*(.*)$/
  for (let i = 0; i < lines.length; i++) {
    const m = rootRe.exec(lines[i] ?? '')
    if (m) {
      lines[i] = `layout: ${layout}${m[1] ?? ''}`
      return lines.join(nl)
    }
  }
  // Insert before the first root-level content line (after leading fences /
  // comments / blanks).
  let insertAt = 0
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim()
    if (t === '' || t.startsWith('#') || /^(---|\.\.\.)$/.test(t)) {
      insertAt = i + 1
      continue
    }
    break
  }
  lines.splice(insertAt, 0, `layout: ${layout}`)
  return lines.join(nl)
}

/* ------------------------------------------------------------------ */
/* Theme → app chrome                                                 */
/* ------------------------------------------------------------------ */

/**
 * The shadcn design tokens this module manages. They're cleared on every apply
 * (restoring the static `:root` palette from globals.css) and then re-set from
 * the current `themeVariables`, so removing a theme reverts the whole site.
 */
const MANAGED_TOKENS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--border',
  '--input',
  '--ring',
  '--sidebar',
  '--sidebar-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-border',
  '--sidebar-ring',
  '--font-sans',
  '--font-mono',
] as const

/**
 * Map a mermaid `themeVariables` object onto the app's shadcn CSS tokens so the
 * whole chrome adopts the diagram's palette. Best-effort and defensive: every
 * token has a sensible fallback chain, and unset tokens fall back to the static
 * palette (because we clear them first). Passing a config with no
 * `themeVariables` resets the site to its default look.
 */
export function applyThemeToSite(config: MermaidUserConfig | null): void {
  if (typeof document === 'undefined' || !document.body) return
  // Target <body>, not <html>: next/font sets --font-sans/--font-mono on <body>
  // via a className, and an inline style on the same element outranks it. Every
  // visible node (including portaled dialogs/toasts) lives under <body>, so the
  // color tokens cascade site-wide too.
  const root = document.body
  for (const token of MANAGED_TOKENS) root.style.removeProperty(token)

  const tv = config?.themeVariables
  if (!isPlainObject(tv)) return

  // Pull the semantically meaningful colors, coercing to strings.
  const v = (key: string): string | undefined => {
    const raw = (tv as Record<string, unknown>)[key]
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
  }
  const first = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const val = v(k)
      if (val) return val
    }
    return undefined
  }

  const text = first('primaryTextColor', 'textColor', 'nodeTextColor')
  const bg = first('background', 'secondaryColor', 'mainBkg')
  const surface = first('mainBkg', 'primaryColor', 'secondaryColor', 'background')
  const secondary = first('secondaryColor', 'tertiaryColor', 'mainBkg')
  const muted = first('tertiaryColor', 'secondaryColor', 'mainBkg')
  const accentLine = first('primaryBorderColor', 'lineColor', 'nodeBorder')
  const borderColor = first('primaryBorderColor', 'nodeBorder', 'clusterBorder', 'lineColor')
  const font = first('fontFamily')

  const set = (token: string, value: string | undefined) => {
    if (value) root.style.setProperty(token, value)
  }
  // A muted-but-legible text color, derived when we have both text + a surface.
  const mutedText =
    text && surface ? `color-mix(in srgb, ${text} 60%, ${surface})` : text

  set('--background', bg)
  set('--foreground', text)
  set('--card', surface)
  set('--card-foreground', text)
  set('--popover', surface)
  set('--popover-foreground', text)
  set('--secondary', secondary)
  set('--secondary-foreground', text)
  set('--muted', muted)
  set('--muted-foreground', mutedText)
  set('--accent', secondary)
  set('--accent-foreground', text)
  set('--border', borderColor)
  set('--input', borderColor)
  set('--ring', accentLine)
  set('--primary', accentLine)
  set('--primary-foreground', bg ?? surface)
  set('--sidebar', bg ?? surface)
  set('--sidebar-foreground', text)
  set('--sidebar-primary', accentLine)
  set('--sidebar-primary-foreground', bg ?? surface)
  set('--sidebar-accent', secondary)
  set('--sidebar-accent-foreground', text)
  set('--sidebar-border', borderColor)
  set('--sidebar-ring', accentLine)

  if (font) {
    set('--font-sans', font)
    set('--font-mono', font)
  }
}
