import { THEMES, fromShikiTheme, type DiagramColors } from 'beautiful-mermaid'
import type { ThemeOption } from './types'

/**
 * Theme registry. Two sources:
 *  - beautiful-mermaid's built-in `THEMES` (resolve synchronously).
 *  - A curated set of Shiki / VS Code themes, loaded on demand and mapped
 *    through `fromShikiTheme()`.
 */

function prettify(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
}

const DARK_BUILTINS = new Set([
  'zinc-dark',
  'tokyo-night',
  'tokyo-night-storm',
  'catppuccin-mocha',
  'nord',
  'dracula',
  'github-dark',
  'solarized-dark',
  'one-dark',
])

export const BUILTIN_THEMES: ThemeOption[] = Object.keys(THEMES).map((id) => ({
  id,
  label: prettify(id),
  kind: 'builtin',
  dark: DARK_BUILTINS.has(id),
}))

/** Curated Shiki bundled themes that broaden the palette beyond the built-ins. */
const SHIKI_THEME_DEFS: Array<{ id: string; dark: boolean }> = [
  { id: 'vitesse-dark', dark: true },
  { id: 'vitesse-light', dark: false },
  { id: 'monokai', dark: true },
  { id: 'material-theme-palenight', dark: true },
  { id: 'rose-pine', dark: true },
  { id: 'rose-pine-dawn', dark: false },
  { id: 'night-owl', dark: true },
  { id: 'ayu-dark', dark: true },
  { id: 'poimandres', dark: true },
  { id: 'min-light', dark: false },
]

export const SHIKI_THEMES: ThemeOption[] = SHIKI_THEME_DEFS.map(({ id, dark }) => ({
  id,
  label: prettify(id),
  kind: 'shiki',
  dark,
}))

export const ALL_THEMES: ThemeOption[] = [...BUILTIN_THEMES, ...SHIKI_THEMES]

export const DEFAULT_THEME_ID = 'tokyo-night'

export function getThemeOption(id: string): ThemeOption | undefined {
  return ALL_THEMES.find((t) => t.id === id)
}

/**
 * Drop fully-transparent roles so beautiful-mermaid's `color-mix` fallbacks are
 * used instead. Some Shiki themes map, e.g., `focusBorder` to a transparent
 * color, which would otherwise render arrows/borders invisible.
 */
function sanitizeColors(colors: DiagramColors): DiagramColors {
  const isTransparent = (c: string | undefined) =>
    typeof c === 'string' && /^#[0-9a-f]{6}00$/i.test(c.trim())
  const out: DiagramColors = { bg: colors.bg, fg: colors.fg }
  for (const key of ['line', 'accent', 'muted', 'surface', 'border'] as const) {
    const v = colors[key]
    if (v && !isTransparent(v)) out[key] = v
  }
  return out
}

const cache = new Map<string, DiagramColors>()

/**
 * Resolve a theme id to concrete diagram colors. Built-ins are synchronous;
 * Shiki themes trigger a lazy dynamic import of `shiki` (kept out of the initial
 * bundle) the first time one is selected.
 */
export async function resolveTheme(id: string): Promise<DiagramColors> {
  const cached = cache.get(id)
  if (cached) return cached

  const builtin = THEMES[id]
  if (builtin) {
    cache.set(id, builtin)
    return builtin
  }

  const { getSingletonHighlighter } = await import('shiki')
  const hl = await getSingletonHighlighter({ themes: [id], langs: [] })
  const colors = sanitizeColors(fromShikiTheme(hl.getTheme(id)))
  cache.set(id, colors)
  return colors
}
