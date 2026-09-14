import { load, YAMLException } from 'js-yaml'
import { THEME_PRESETS, type ThemePreset } from './themes'
import {
  TEXT_CONTRAST,
  UI_CONTRAST,
  ensureContrast,
  mixColors,
  relativeLuminance,
} from './color'

/** The user-editable mermaid config (the cogwheel next to the layout dropdown). */

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
export const CONFIG_PLACEHOLDER = `config:
  theme: base
  themeVariables:
    primaryColor: '#e5e9f0'
    primaryTextColor: '#2e3440'
    primaryBorderColor: '#5e81ac'
    lineColor: '#5e81ac'
    background: '#eceff4'
`

/** Parse the user's YAML config text into a plain object. */
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
/* Export (diagram code + config, as a standalone .mmd source)        */
/* ------------------------------------------------------------------ */

/**
 * Combine the diagram text with the global config as a real mermaid YAML frontmatter block, so the
 * exported source stands alone (renders identically if pasted elsewhere).
 */
export function buildExportSource(text: string, mermaidConfigYaml: string): string {
  if (!mermaidConfigYaml.trim()) return text

  const lines = mermaidConfigYaml.replace(/\r\n/g, '\n').split('\n')
  const hasConfigKey = lines.some((l) => /^config\s*:\s*(#.*)?$/.test(l))
  const body = hasConfigKey
    ? lines.join('\n').replace(/\n+$/, '')
    : ['config:', ...lines.map((l) => (l.trim() ? `  ${l}` : l))].join('\n').replace(/\n+$/, '')

  return `---\n${body}\n---\n\n${text}`
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
 * Set the top-level `layout` key in the raw YAML text, so the layout dropdown can write back into
 * the config that is the single source of truth.
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
/* Theme presets (the dropdown edits the YAML)                        */
/* ------------------------------------------------------------------ */

/** A stable, order-independent signature of a `themeVariables` map, used to tell
 *  which preset (if any) a config currently matches. */
function themeVarsSignature(vars: unknown): string | null {
  if (!isPlainObject(vars)) return null
  const entries = Object.entries(vars)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([k, val]) => [k, val.trim()] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return entries.length ? JSON.stringify(entries) : null
}

/**
 * Identify which preset theme the config currently reflects, by matching its `themeVariables`
 * against each preset's.
 */
export function themeFromConfig(config: MermaidUserConfig | null): ThemePreset | null {
  const sig = themeVarsSignature(config?.themeVariables)
  if (sig == null) return null
  return THEME_PRESETS.find((p) => themeVarsSignature(p.themeVariables) === sig) ?? null
}

/**
 * Write a preset theme (its `theme` + `themeVariables`) into the raw YAML text, the single source
 * of truth — or, with `preset === null`, strip both keys to revert to the default look.
 */
export function setThemeInYaml(yaml: string, preset: ThemePreset | null): string {
  const nl = yaml.includes('\r\n') ? '\r\n' : '\n'
  const indentOf = (line: string): number => line.match(/^\s*/)?.[0].length ?? 0

  let lines = yaml ? yaml.split(/\r?\n/) : []

  // Where do the theme keys live: under a top-level `config:` mapping
  // (frontmatter form) or at the document root (bare-body form)?
  const configIdx = lines.findIndex((l) => /^config\s*:\s*(#.*)?$/.test(l))
  const frontmatter = configIdx >= 0

  // The indentation of the `theme` / `themeVariables` keys themselves.
  let keyIndent = ''
  if (frontmatter) {
    keyIndent = '  '
    for (let i = configIdx + 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '' || /^\s*#/.test(line)) continue
      if (indentOf(line) === 0) break // block has no children
      keyIndent = line.match(/^\s*/)?.[0] ?? '  '
      break
    }
  }
  const keyLen = keyIndent.length

  // Remove any existing `theme:` scalar and `themeVariables:` block at that level
  // (the block being the key line plus every more-indented line beneath it).
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (indentOf(line) === keyLen && /^theme\s*:/.test(trimmed)) continue
    if (indentOf(line) === keyLen && /^themeVariables\s*:/.test(trimmed)) {
      let j = i + 1
      while (j < lines.length) {
        const child = lines[j] ?? ''
        if (child.trim() === '' || indentOf(child) > keyLen) {
          j++
          continue
        }
        break
      }
      i = j - 1
      continue
    }
    kept.push(line)
  }
  lines = kept

  if (!preset) {
    const out = lines.join(nl)
    return out.trim() ? out : ''
  }

  const subIndent = keyIndent + '  '
  const themeLines = [
    `${keyIndent}theme: ${preset.theme}`,
    `${keyIndent}themeVariables:`,
    ...Object.entries(preset.themeVariables).map(([k, val]) => `${subIndent}${k}: '${val}'`),
  ]

  if (frontmatter) {
    const idx = lines.findIndex((l) => /^config\s*:\s*(#.*)?$/.test(l))
    lines.splice(idx + 1, 0, ...themeLines)
    return lines.join(nl)
  }

  // Bare-body form. An empty (or whitespace/comment-only) config gets a fresh
  // block; otherwise insert after any leading fences / comments / blank lines.
  if (!lines.join('').trim()) return themeLines.join(nl) + nl
  let insertAt = 0
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim()
    if (t === '' || t.startsWith('#') || /^(---|\.\.\.)$/.test(t)) {
      insertAt = i + 1
      continue
    }
    break
  }
  lines.splice(insertAt, 0, ...themeLines)
  return lines.join(nl)
}

/* ------------------------------------------------------------------ */
/* Theme → app chrome                                                 */
/* ------------------------------------------------------------------ */

/** The shadcn design tokens this module manages. */
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
 * Map a mermaid `themeVariables` object onto the app's shadcn CSS tokens so the whole chrome adopts
 * the diagram's palette.
 */
export function applyThemeToSite(config: MermaidUserConfig | null): void {
  if (typeof document === 'undefined' || !document.body) return
  // Target <body>, not <html>: next/font sets --font-sans/--font-mono on <body>
  // via a className, and an inline style on the same element outranks it. Every
  // visible node (including portaled dialogs/toasts) lives under <body>, so the
  // color tokens cascade site-wide too.
  const root = document.body
  for (const token of MANAGED_TOKENS) root.style.removeProperty(token)

  // `color-scheme` goes on <html>, not <body>: it decides how the browser paints the UI it draws
  // itself — the window scrollbar, form controls, and any scrollbar in a subtree the app's CSS
  // can't reach — and the window scrollbar belongs to the root element.
  const html = document.documentElement
  const tv = config?.themeVariables
  if (!isPlainObject(tv)) {
    html.style.removeProperty('color-scheme')
    return
  }
  html.style.colorScheme = resolveThemeMode(config)

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

  /**
   * A token that carries text, lifted until it clears WCAG AA against every surface it is actually
   * painted on.
   */
  const legible = (value: string | undefined, ...surfaces: (string | undefined)[]) =>
    value ? ensureContrast(value, surfaces, TEXT_CONTRAST) : value

  // A muted-but-legible text color: the palette's text blended toward the page, then lifted back to
  // AA if the blend went too far.
  const mutedBlend = text && bg ? mixColors(text, bg, 0.4) : undefined
  const mutedText = mutedBlend
    ? ensureContrast(mutedBlend, [bg, surface], TEXT_CONTRAST)
    : text && surface
      ? `color-mix(in srgb, ${text} 60%, ${surface})`
      : text
  // Dividers/panel edges/input outlines want a quiet hairline, not the bold
  // accent mermaid uses for node borders — blend it mostly toward the surface
  // so it reads as a subtle line instead of a high-contrast stroke. Left as-is:
  // a border is not text, and a hairline you can barely see is the intent.
  const surfaceBg = bg ?? surface
  const softBorder =
    borderColor && surfaceBg
      ? `color-mix(in srgb, ${borderColor} 25%, ${surfaceBg})`
      : borderColor

  set('--background', bg)
  set('--foreground', legible(text, bg))
  set('--card', surface)
  set('--card-foreground', legible(text, surface))
  set('--popover', surface)
  set('--popover-foreground', legible(text, surface))
  set('--secondary', secondary)
  set('--secondary-foreground', legible(text, secondary))
  set('--muted', muted)
  set('--muted-foreground', mutedText)
  set('--accent', secondary)
  set('--accent-foreground', legible(text, secondary))
  set('--border', softBorder)
  set('--input', softBorder)
  // A focus ring is a graphical object, not text, so it answers to the lower of
  // the two WCAG thresholds.
  set('--ring', accentLine && ensureContrast(accentLine, [bg, surface], UI_CONTRAST))
  // `--primary` is the accent *and* the editor's keyword/heading colour, and it
  // backs filled buttons whose label is `--primary-foreground` (the page colour)
  // — so one floor here fixes syntax highlighting and button labels together.
  set('--primary', legible(accentLine, bg, surface))
  set('--primary-foreground', bg ?? surface)
  set('--sidebar', bg ?? surface)
  set('--sidebar-foreground', legible(text, bg ?? surface))
  set('--sidebar-primary', legible(accentLine, bg ?? surface))
  set('--sidebar-primary-foreground', bg ?? surface)
  set('--sidebar-accent', secondary)
  set('--sidebar-accent-foreground', legible(text, secondary))
  set('--sidebar-border', softBorder)
  set('--sidebar-ring', accentLine && ensureContrast(accentLine, [bg, surface], UI_CONTRAST))

  if (font) {
    set('--font-sans', font)
    set('--font-mono', font)
  }
}

/* ------------------------------------------------------------------ */
/* Theme → light/dark mode                                            */
/* ------------------------------------------------------------------ */

/** Whether the active palette reads as a light or a dark theme. */
export type ThemeMode = 'light' | 'dark'

/** Whether `color` is dark enough to favor light foreground text. */
export function isDarkColor(color: string): boolean | null {
  const luminance = relativeLuminance(color)
  if (luminance === null) return null
  return luminance < DARK_LUMINANCE_THRESHOLD
}

const DARK_LUMINANCE_THRESHOLD = 0.179

/** The active palette's own background color, or undefined when no theme sets one. */
export function themeBackgroundColor(config: MermaidUserConfig | null): string | undefined {
  const raw = config?.themeVariables?.background
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

/**
 * The light/dark mode of the active palette — used to pick the matching Excalidraw theme, which
 * (unlike mermaid's `themeVariables`) is a binary light/dark switch rather than an arbitrary
 * palette.
 */
export function resolveThemeMode(config: MermaidUserConfig | null): ThemeMode {
  const preset = themeFromConfig(config)
  if (preset) return preset.mode

  const tv = config?.themeVariables
  if (isPlainObject(tv)) {
    for (const key of ['background', 'mainBkg', 'secondaryColor', 'primaryColor']) {
      const raw = (tv as Record<string, unknown>)[key]
      if (typeof raw !== 'string' || !raw.trim()) continue
      const dark = isDarkColor(raw)
      if (dark === null) continue
      return dark ? 'dark' : 'light'
    }
  }

  return 'light'
}

/* ------------------------------------------------------------------ */
/* Packet diagrams                                                    */
/* ------------------------------------------------------------------ */

/** A `packet` block for mermaid's theme, derived from the palette's own tokens. */
export function packetThemeVariables(
  vars: Record<string, unknown>,
): Record<string, string> | null {
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const raw = vars[key]
      if (typeof raw === 'string' && raw.trim()) return raw.trim()
    }
    return undefined
  }

  const text = first('primaryTextColor', 'textColor', 'nodeTextColor')
  const bg = first('background', 'mainBkg', 'primaryColor')
  const block = first('mainBkg', 'primaryColor', 'secondaryColor', 'background')
  const stroke = first('nodeBorder', 'primaryBorderColor', 'clusterBorder', 'lineColor')

  // Nothing to derive from: leave mermaid's own defaults in place rather than
  // inventing half a palette. A config with no colors in it is the untinted
  // default theme, whose light background those defaults were written for.
  if (!text && !block && !stroke) return null

  const packet: Record<string, string> = {}
  if (text) {
    const onBackground = ensureContrast(text, [bg], TEXT_CONTRAST)
    packet.startByteColor = onBackground
    packet.endByteColor = onBackground
    packet.titleColor = onBackground
    packet.labelColor = ensureContrast(text, [block], TEXT_CONTRAST)
  }
  if (stroke) packet.blockStrokeColor = stroke
  if (block) packet.blockFillColor = block
  return packet
}
