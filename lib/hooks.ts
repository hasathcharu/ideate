'use client'

import { useEffect, useState } from 'react'

/**
 * Debounce a rapidly-changing value (e.g. editor text → preview render).
 *
 * `resetKey` identifies *which* value is being debounced — pass the open
 * document's id. When it changes, the incoming value is adopted immediately
 * instead of after `delayMs`, because a delay only makes sense while editing one
 * document; across a switch it just serves the previous document's content.
 *
 * That staleness was doing real damage, not just flickering:
 *  - the preview rendered the outgoing file for a full delay window, so opening a
 *    mermaid diagram right after an Excalidraw scene fed mermaid the scene's JSON
 *    and painted its parse-error dump;
 *  - the draft-autosave effect fires on `docId` change too, so it wrote the
 *    *previous* document's text into the *new* document's localStorage slot —
 *    which became the restored draft if the user switched again within the window.
 */
export function useDebouncedValue<T>(value: T, delayMs: number, resetKey?: unknown): T {
  const [debounced, setDebounced] = useState(value)
  const [key, setKey] = useState(resetKey)

  // Adjusting state during render is React's supported way to respond to a
  // changed input: it re-renders before committing, so no stale frame is painted.
  if (key !== resetKey) {
    setKey(resetKey)
    setDebounced(value)
  }

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])

  return debounced
}

const MOBILE_BREAKPOINT_QUERY = '(max-width: 1000px)'

/** Tracks whether the viewport is at or below Tailwind's `md` breakpoint. */
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
