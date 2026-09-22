import { describe, expect, it } from 'vitest'
import { THEME_PRESETS } from './themes'
import {
  SURFACE_SEPARATION,
  contrastRatio,
  ensureSurfaceSeparation,
} from './color'

/** The same precedence `applyThemeToSite` reads these tokens with. */
function first(
  vars: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = vars?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

describe('ensureSurfaceSeparation', () => {
  it('leaves a fill that is already distinct alone', () => {
    // Nord's authored secondary clears the floor against its own surface.
    expect(ensureSurfaceSeparation('#3f3f46', '#fafafa', ['#18181b'])).toBe('#3f3f46')
  })

  it('lightens a fill that matches a dark surface', () => {
    const out = ensureSurfaceSeparation('#073642', '#839496', ['#073642'])
    expect(out).not.toBe('#073642')
    expect(contrastRatio(out, '#073642')).toBeGreaterThanOrEqual(SURFACE_SEPARATION)
  })

  it('darkens a fill that matches a light surface', () => {
    const out = ensureSurfaceSeparation('#eee8d5', '#657b83', ['#eee8d5'])
    expect(contrastRatio(out, '#eee8d5')).toBeGreaterThanOrEqual(SURFACE_SEPARATION)
    // Toward the palette's text, which on a light theme means darker.
    expect(contrastRatio(out, '#000000')).toBeLessThan(contrastRatio('#eee8d5', '#000000')!)
  })

  it('separates from every surface it is given, not just the first', () => {
    const out = ensureSurfaceSeparation('#073642', '#839496', ['#073642', '#002b36'])
    expect(contrastRatio(out, '#073642')).toBeGreaterThanOrEqual(SURFACE_SEPARATION)
    expect(contrastRatio(out, '#002b36')).toBeGreaterThanOrEqual(SURFACE_SEPARATION)
  })

  it('returns the fill unchanged when a color cannot be read statically', () => {
    expect(ensureSurfaceSeparation('#073642', undefined, ['#073642'])).toBe('#073642')
    expect(ensureSurfaceSeparation('#073642', '#839496', [])).toBe('#073642')
  })

  // The bug this exists for: several presets author `secondaryColor` as the very
  // color they use for `mainBkg`, so the selected segment of the export menu's
  // toggles was painted the same color as the popover behind it.
  it('makes every preset’s selected-state fill visible against its own surfaces', () => {
    for (const preset of THEME_PRESETS) {
      const vars = preset.themeVariables as Record<string, unknown> | undefined
      const authored = first(vars, 'secondaryColor', 'tertiaryColor', 'mainBkg')
      const text = first(vars, 'primaryTextColor', 'textColor', 'nodeTextColor')
      const surface = first(vars, 'mainBkg', 'primaryColor', 'secondaryColor', 'background')
      const bg = first(vars, 'background')
      if (!authored || !text || !surface) continue

      const secondary = ensureSurfaceSeparation(authored, text, [surface, bg])
      expect(
        contrastRatio(secondary, surface),
        `${preset.value} fill vs surface`,
      ).toBeGreaterThanOrEqual(SURFACE_SEPARATION)
    }
  })
})
