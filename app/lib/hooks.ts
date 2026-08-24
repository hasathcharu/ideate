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
 *
 * **The key and the value it belongs to are one piece of state, and the switch is
 * handled on the way out rather than by writing state during render.** The
 * previous version kept them in two `useState`s and adjusted both from the render
 * body — React's documented way to react to a changed input, and it still returned
 * the *old* value on the pass that scheduled the update, on the assumption that
 * React would discard that pass and re-run. React does not always discard it: the
 * pass gets committed, mount effects run, and a freshly mounted preview therefore
 * received the outgoing document's text and rendered it before the corrected pass
 * arrived. One `{key, value}` snapshot cannot disagree with itself, so the switch
 * is answered by a comparison instead — every pass, committed or not, returns the
 * value that belongs to the key it was asked about.
 */
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
