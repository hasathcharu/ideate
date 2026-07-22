import { renderMermaidSVG, type DiagramColors, type RenderOptions } from 'beautiful-mermaid'
import { mixSrgb, parseColor, toHex } from './color'
import { enhanceSequenceSVG } from './sequence'

/**
 * beautiful-mermaid emits an SVG whose element colors reference internal
 * CSS custom properties (`--_line`, `--_node-fill`, …). Those are derived in the
 * SVG's `<style>` block from a small base palette (`--bg`, `--fg`, and optional
 * `--line`/`--accent`/`--muted`/`--surface`/`--border`) via `color-mix()`.
 *
 * For the LIVE preview we render once with the base palette pointed at CSS
 * variables and set those variables on the container — so switching themes is a
 * pure CSS update with no re-render.
 *
 * For EXPORT we must turn those variables into literal colors (see lib/export.ts),
 * which is why the color-mix derivations are reproduced faithfully below.
 */

/**
 * Render options that make the SVG read its palette from inherited CSS vars.
 *
 * IMPORTANT: the outer variable names (`--mm-bg`/`--mm-fg`) must DIFFER from the
 * SVG's own internal `--bg`/`--fg`. The renderer emits `style="--bg:var(--mm-bg)"`
 * on the <svg>; if we reused `--bg` here it would become `--bg:var(--bg)`, a
 * self-reference cycle that CSS treats as invalid — collapsing node fills and
 * node text to black. Distinct names keep the reference pointing at the parent.
 */
const LIVE_OPTIONS: RenderOptions = {
  bg: 'var(--mm-bg)',
  fg: 'var(--mm-fg)',
  transparent: true,
}

/** Render the theme-agnostic SVG (colors come from inherited CSS variables).
 *  Sequence diagrams are post-processed to widen label spacing and mirror the
 *  participants to the bottom (see lib/sequence.ts). */
export function renderThemeableSVG(text: string): string {
  return enhanceSequenceSVG(renderMermaidSVG(text, LIVE_OPTIONS))
}

export interface RenderResult {
  ok: true
  svg: string
}
export interface RenderError {
  ok: false
  message: string
}

/**
 * Render the diagram once in "CSS variable" mode. The returned SVG is
 * theme-agnostic; colors come from CSS custom properties set on its container.
 */
export function renderPreview(text: string): RenderResult | RenderError {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, message: 'Empty diagram.' }
  try {
    const svg = renderThemeableSVG(text)
    return { ok: true, svg }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** Roles read (by bare name) inside beautiful-mermaid's own <style> block. */
const OPTIONAL_ROLES = ['line', 'accent', 'muted', 'surface', 'border'] as const

/**
 * Map a theme's colors to the CSS custom properties consumed by the live
 * preview SVG.
 *
 * `bg`/`fg` are emitted under the outer `--mm-*` names (see `LIVE_OPTIONS`) to
 * avoid a self-reference cycle. Each optional role is emitted under its bare
 * name (`--line`, `--accent`, …) because the SVG's `<style>` reads those
 * directly. Roles the theme does NOT define are set to `initial` — crucial now
 * that shadcn defines `--accent`/`--muted`/`--border` on the document root: the
 * explicit `initial` shields the SVG from those, so its `var(--x, fallback)`
 * color-mix fallbacks apply instead of the app's chrome colors leaking in.
 */
export function colorsToCssVars(colors: DiagramColors): Record<string, string> {
  const out: Record<string, string> = {
    '--mm-bg': colors.bg,
    '--mm-fg': colors.fg,
  }
  for (const key of OPTIONAL_ROLES) {
    out[`--${key}`] = colors[key] ?? 'initial'
  }
  return out
}

/**
 * Derive the shadcn/ui design tokens from the active diagram theme, so the whole
 * UI matches the diagram. Returned as CSS custom properties to set on the
 * document root (covering portaled overlays too).
 */
export function colorsToChromeVars(colors: DiagramColors): Record<string, string> {
  const bg = parseColor(colors.bg)
  const fg = parseColor(colors.fg)
  const mix = (pct: number, base: string): string => {
    const b = parseColor(base)
    return fg && b ? toHex(mixSrgb(fg, b, pct)) : base
  }

  const accent = colors.accent ?? mix(85, colors.bg)
  const accentRgb = parseColor(accent)
  const accentLum = accentRgb
    ? (0.299 * accentRgb.r + 0.587 * accentRgb.g + 0.114 * accentRgb.b) / 255
    : 0.5
  const onAccent = accentLum > 0.6 ? '#0b0e14' : '#ffffff'

  const card = mix(4, colors.bg)
  const border = colors.border ?? mix(18, colors.bg)
  const mutedFg = colors.muted ?? mix(55, colors.bg)

  return {
    '--background': colors.bg,
    '--foreground': colors.fg,
    '--card': card,
    '--card-foreground': colors.fg,
    '--popover': mix(6, colors.bg),
    '--popover-foreground': colors.fg,
    '--primary': accent,
    '--primary-foreground': onAccent,
    '--secondary': mix(10, colors.bg),
    '--secondary-foreground': colors.fg,
    '--muted': mix(8, colors.bg),
    '--muted-foreground': mutedFg,
    '--accent': mix(12, colors.bg),
    '--accent-foreground': colors.fg,
    '--border': border,
    '--input': mix(14, colors.bg),
    '--ring': accent,
    '--sidebar': card,
    '--sidebar-foreground': colors.fg,
    '--sidebar-primary': accent,
    '--sidebar-primary-foreground': onAccent,
    '--sidebar-accent': mix(12, colors.bg),
    '--sidebar-accent-foreground': colors.fg,
    '--sidebar-border': border,
    '--sidebar-ring': accent,
  }
}

/**
 * Resolve a theme into a complete map of every CSS variable the SVG references
 * (base + internal `--_*`) as literal hex colors. This mirrors the derivation in
 * beautiful-mermaid's own `<style>` block. Used by the exporter to inline colors.
 */
export function resolveThemeVariables(colors: DiagramColors): Record<string, string> {
  const bg = parseColor(colors.bg)
  const fg = parseColor(colors.fg)

  // If the palette isn't plain hex/rgb we can't do the math; fall back to
  // passing the raw values through and letting mix() default sensibly.
  const mix = (pct: number, fallback: string): string => {
    if (!fg || !bg) return fallback
    return toHex(mixSrgb(fg, bg, pct))
  }

  const line = colors.line ?? mix(50, colors.fg)
  const accent = colors.accent ?? mix(85, colors.fg)
  const surface = colors.surface ?? mix(3, colors.bg)
  const border = colors.border ?? mix(20, colors.fg)
  const muted40 = colors.muted ?? mix(40, colors.fg)
  const muted60 = colors.muted ?? mix(60, colors.fg)

  return {
    '--bg': colors.bg,
    '--fg': colors.fg,
    '--line': line,
    '--accent': accent,
    '--muted': colors.muted ?? muted40,
    '--surface': surface,
    '--border': border,
    // Internal derived variables (exact names from the rendered <style> block):
    '--_text': colors.fg,
    '--_text-sec': muted60,
    '--_text-muted': muted40,
    '--_text-faint': mix(25, colors.fg),
    '--_line': line,
    '--_arrow': accent,
    '--_node-fill': surface,
    '--_node-stroke': border,
    '--_group-fill': colors.bg,
    '--_group-hdr': mix(5, colors.fg),
    '--_inner-stroke': mix(12, colors.fg),
    '--_key-badge': mix(10, colors.fg),
  }
}
