'use client'

import { useEffect, useMemo, useState } from 'react'

/** Debounce a rapidly-changing value (e.g. editor text → preview render). */
export function useDebouncedValue<T>(value: T, delayMs: number, resetKey?: unknown): T {
  const [snapshot, setSnapshot] = useState<{ key: unknown; value: T }>({ key: resetKey, value })

  useEffect(() => {
    const id = setTimeout(() => {
      // Same key and same value means the snapshot already says this; replacing it
      // with an equal one would be a render per delay window forever.
      setSnapshot((prev) =>
        prev.key === resetKey && prev.value === value ? prev : { key: resetKey, value },
      )
    }, delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs, resetKey])

  // Between a switch and the first tick under the new key there is no debounced
  // value for *this* document, and the live one is the only honest answer.
  return snapshot.key === resetKey ? snapshot.value : value
}

const MOBILE_BREAKPOINT_QUERY = '(max-width: 1000px)'

/** Tracks the app's minimum comfortable two-pane editor width. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_BREAKPOINT_QUERY)
    setIsMobile(mql.matches)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isMobile
}

/** A stable `dangerouslySetInnerHTML` value for `html`. */
export function useInnerHtml(html: string): { __html: string } {
  return useMemo(() => ({ __html: html }), [html])
}
