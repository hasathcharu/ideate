'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_LAYOUT, LAYOUT_ENGINES } from '@/lib/mermaid'
import {
  applyThemeToSite,
  layoutFromConfig,
  parseMermaidConfig,
  resolveThemeMode,
  setThemeInYaml,
  themeBackgroundColor,
  themeFromConfig,
  type MermaidUserConfig,
} from '@/lib/mermaidConfig'
import { THEME_PRESETS } from '@/lib/themes'
import type { AppConfig } from '@/lib/types'

export const NONE_THEME = '__none__'
export const CUSTOM_THEME = '__custom__'
const LAYOUT_VALUES = LAYOUT_ENGINES.map((engine) => engine.value)

/** Derives all render-surface appearance from the persisted Mermaid YAML config. */
export function useAppearanceController(
  config: AppConfig,
  updateConfig: (patch: Partial<AppConfig>) => void,
) {
  const parsedConfig = useMemo(
    () => parseMermaidConfig(config.mermaidConfig),
    [config.mermaidConfig],
  )
  const [appliedConfig, setAppliedConfig] = useState<MermaidUserConfig | null>(null)

  useEffect(() => {
    if (parsedConfig.error) return
    setAppliedConfig(parsedConfig.config)
    applyThemeToSite(parsedConfig.config)
  }, [parsedConfig])

  const currentLayout = layoutFromConfig(appliedConfig, LAYOUT_VALUES, DEFAULT_LAYOUT)
  const currentTheme = useMemo(() => {
    const matched = themeFromConfig(appliedConfig)
    if (matched) return matched.value
    const variables = appliedConfig?.themeVariables
    const hasVariables = !!variables && typeof variables === 'object' && Object.keys(variables).length > 0
    return hasVariables ? CUSTOM_THEME : NONE_THEME
  }, [appliedConfig])

  const applyTheme = useCallback((value: string) => {
    if (value === CUSTOM_THEME) return
    const preset = value === NONE_THEME ? null : THEME_PRESETS.find((item) => item.value === value)
    if (value !== NONE_THEME && !preset) return
    updateConfig({ mermaidConfig: setThemeInYaml(config.mermaidConfig, preset ?? null) })
  }, [config.mermaidConfig, updateConfig])

  const canvasTheme = useMemo(() => resolveThemeMode(appliedConfig), [appliedConfig])
  const canvasBackground = useMemo(() => themeBackgroundColor(appliedConfig), [appliedConfig])

  return {
    parsedConfig,
    appliedConfig,
    currentLayout,
    currentTheme,
    applyTheme,
    canvasTheme,
    canvasBackground,
    editorDark: canvasTheme === 'dark',
  }
}
