'use client'

import { useEffect, useState } from 'react'
import type { DiagramColors } from 'beautiful-mermaid'
import { getThemeOption, resolveTheme } from './themes'
import { colorsToChromeVars } from './mermaid'

/**
 * Apply the active diagram theme to the shadcn design tokens on the document
 * root, so the entire UI (including portaled dialogs/menus) matches the diagram.
 * Also toggles the `dark` class for components that branch on it.
 */
export function useChromeTheme(colors: DiagramColors | null, dark: boolean): void {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    root.classList.toggle('dark', dark)
    root.style.colorScheme = dark ? 'dark' : 'light'
    if (!colors) return
    const vars = colorsToChromeVars(colors)
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value)
    }
  }, [colors, dark])
}

/** Debounce a rapidly-changing value (e.g. editor text → preview render). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

export interface ResolvedTheme {
  colors: DiagramColors | null
  dark: boolean
  loading: boolean
}

/**
 * Resolve a theme id to concrete colors. Built-ins resolve immediately; Shiki
 * themes resolve asynchronously (lazy import). While a new theme loads, the
 * previous colors are kept so the preview never flashes empty.
 */
export function useResolvedTheme(themeId: string): ResolvedTheme {
  const option = getThemeOption(themeId)
  const [colors, setColors] = useState<DiagramColors | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    resolveTheme(themeId)
      .then((resolved) => {
        if (!cancelled) {
          setColors(resolved)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [themeId])

  return { colors, dark: option?.dark ?? true, loading }
}
