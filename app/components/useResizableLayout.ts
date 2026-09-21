'use client'

import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { AppConfig } from '@/lib/types'

export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 480
const MIN_EDITOR_RATIO = 0.2
const MAX_EDITOR_RATIO = 0.8

export function useResizableLayout(updateConfig: (patch: Partial<AppConfig>) => void) {
  const [editorRatio, setEditorRatio] = useState(0.5)
  const [sidebarWidth, setSidebarWidth] = useState(256)
  const paneRowRef = useRef<HTMLDivElement>(null)

  const startDividerDrag = useCallback((event: PointerEvent) => {
    event.preventDefault()
    const row = paneRowRef.current
    if (!row) return
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const rect = row.getBoundingClientRect()
      if (rect.width === 0) return
      const raw = (moveEvent.clientX - rect.left) / rect.width
      setEditorRatio(Math.min(MAX_EDITOR_RATIO, Math.max(MIN_EDITOR_RATIO, raw)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setEditorRatio((ratio) => {
        updateConfig({ splitRatio: ratio })
        return ratio
      })
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [updateConfig])

  const onDividerKeyDown = useCallback((event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.02
    const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    if (delta === 0) return
    event.preventDefault()
    setEditorRatio((ratio) => {
      const next = Math.min(MAX_EDITOR_RATIO, Math.max(MIN_EDITOR_RATIO, ratio + delta))
      updateConfig({ splitRatio: next })
      return next
    })
  }, [updateConfig])

  const startSidebarDrag = useCallback((event: PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const next = startWidth + (moveEvent.clientX - startX)
      setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, next)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setSidebarWidth((width) => {
        updateConfig({ sidebarWidth: width })
        return width
      })
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [sidebarWidth, updateConfig])

  const onSidebarDividerKeyDown = useCallback((event: KeyboardEvent) => {
    const step = event.shiftKey ? 40 : 8
    const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    if (delta === 0) return
    event.preventDefault()
    setSidebarWidth((width) => {
      const next = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width + delta))
      updateConfig({ sidebarWidth: next })
      return next
    })
  }, [updateConfig])

  return {
    editorRatio,
    setEditorRatio,
    sidebarWidth,
    setSidebarWidth,
    paneRowRef,
    startDividerDrag,
    onDividerKeyDown,
    startSidebarDrag,
    onSidebarDividerKeyDown,
  }
}
