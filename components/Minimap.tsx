'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { LineChangeKind } from '@/lib/diff'
import { cn } from '@/lib/utils'

/**
 * The viewfinder beside the editor: the whole document at a glance, with the
 * visible region marked and the uncommitted changes banded across it.
 *
 * Drawn on a **canvas**, not as elements. A thousand-line file is a thousand
 * marks, and a thousand absolutely-positioned divs would cost more to lay out
 * than the editor itself; one canvas redraws in well under a frame.
 *
 * Lines get shorter marks the shorter they are and start where their indentation
 * starts, so the shape of the file (headings, blocks, fences) stays recognizable
 * even though no glyph is legible.
 *
 * The scale is **fixed**, and a document taller than the column makes the map
 * itself slide — the same thing VS Code does. Squeezing every line into the
 * available height instead was the obvious first implementation and it is useless
 * past a few hundred lines: every line collapses to a sub-pixel smear and the
 * marks stop meaning anything. Sliding keeps each line 3px tall however long the
 * file is, and moves the map by the editor's *scroll progress* rather than its
 * scroll offset, so the whole document is still reachable and the map drifts
 * slowly against the text.
 */

/** Height of one line's mark. Fixed, so the map reads the same in a 40-line file
 *  and a 4000-line one. */
const LINE_HEIGHT = 3

/** Columns the width represents. Lines longer than this run to the edge, which is
 *  the same thing VS Code's minimap does with its own fixed scale. */
const COLUMNS = 90

export interface MinimapProps {
  /** The document as the editor currently holds it. */
  text: string
  /** Per-line change kinds (1-based lines), or null when there is nothing
   *  committed to compare against. */
  changes: ReadonlyMap<number, LineChangeKind> | null
  /** The editor scroller's live geometry. */
  scroll: { top: number; height: number; scrollHeight: number }
  /** Scroll the editor to this offset, in the scroller's own pixels. */
  onScrollTo: (top: number) => void
  className?: string
}

/** A color from the host element's computed style, so the map follows the active
 *  theme without any of its palette being duplicated here. */
function cssColor(el: HTMLElement, property: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(property).trim()
  return value || fallback
}

export default function Minimap({
  text,
  changes,
  scroll,
  onScrollTo,
  className,
}: MinimapProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const draggingRef = useRef(false)

  // Track the column's own size, so the canvas is drawn at device resolution and
  // redrawn when the pane is resized.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => {
      const rect = host.getBoundingClientRect()
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  const lines = useMemo(() => text.split('\n'), [text])
  /** Height the whole document occupies at the fixed scale. */
  const mapHeight = lines.length * LINE_HEIGHT
  /** How much of the map doesn't fit in the column. */
  const overflow = Math.max(0, mapHeight - size.height)
  /** How far through the scrollable range the editor is, 0–1. */
  const progress =
    scroll.scrollHeight > scroll.height
      ? Math.min(1, Math.max(0, scroll.top / (scroll.scrollHeight - scroll.height)))
      : 0
  /** How much of the map is scrolled off the top. Driven by `progress`, so the
   *  map reaches its own end exactly when the editor reaches the document's. */
  const mapTop = overflow * progress

  // A theme change rewrites custom properties on <body> without touching any prop
  // here, so the redraw has to be triggered by watching for it.
  const [themeTick, setThemeTick] = useState(0)
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeTick((t) => t + 1))
    observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host || size.width === 0 || size.height === 0) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(size.width * ratio)
    canvas.height = Math.round(size.height * ratio)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)

    const foreground = cssColor(host, 'color', '#000')
    const diffColors: Record<LineChangeKind, string> = {
      added: cssColor(host, '--diff-add', '#2f9e44'),
      modified: cssColor(host, '--diff-modified', '#2f74e5'),
      removed: cssColor(host, '--diff-remove', '#e5484d'),
    }
    const charWidth = size.width / COLUMNS
    const markHeight = LINE_HEIGHT - 1

    // Only the slice on screen is drawn, so the cost per frame is the same for a
    // 4000-line file as for a 40-line one.
    const firstLine = Math.max(0, Math.floor(mapTop / LINE_HEIGHT))
    const lastLine = Math.min(
      lines.length,
      Math.ceil((mapTop + size.height) / LINE_HEIGHT) + 1,
    )

    for (let i = firstLine; i < lastLine; i++) {
      const y = i * LINE_HEIGHT - mapTop
      const line = lines[i]!

      // The change band spans the full width, behind the line's own mark, so a
      // run of edits reads as a stripe down the map.
      const kind = changes?.get(i + 1)
      if (kind) {
        ctx.globalAlpha = 0.5
        ctx.fillStyle = diffColors[kind]
        ctx.fillRect(0, y, size.width, LINE_HEIGHT)
      }

      const trimmed = line.trimStart()
      if (!trimmed) continue
      const indent = line.length - trimmed.length
      const x = Math.min(indent * charWidth, size.width - 2)
      const width = Math.max(1, Math.min(trimmed.length * charWidth, size.width - x))
      ctx.globalAlpha = 0.4
      ctx.fillStyle = foreground
      ctx.fillRect(x, y, width, markHeight)
    }
    ctx.globalAlpha = 1
  }, [lines, changes, size, mapTop, themeTick])

  /* ---------------------------------------------------------------- */
  /* Dragging                                                          */
  /* ---------------------------------------------------------------- */

  /** Scroll so that the document position under `clientY` is centred. The map's
   *  own offset has to be added back in, or clicking a mark scrolls somewhere else
   *  entirely once the map has slid. */
  const scrollToPointer = useCallback(
    (clientY: number) => {
      const host = hostRef.current
      if (!host || mapHeight <= 0 || scroll.scrollHeight <= 0) return
      const rect = host.getBoundingClientRect()
      const fraction = (mapTop + (clientY - rect.top)) / mapHeight
      const target = fraction * scroll.scrollHeight - scroll.height / 2
      onScrollTo(Math.max(0, Math.min(scroll.scrollHeight - scroll.height, target)))
    },
    [mapHeight, mapTop, scroll.scrollHeight, scroll.height, onScrollTo],
  )

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      draggingRef.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      scrollToPointer(e.clientY)
    },
    [scrollToPointer],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (draggingRef.current) scrollToPointer(e.clientY)
    },
    [scrollToPointer],
  )

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  // The visible region, expressed from the scroller's own metrics rather than a
  // line count — that way soft-wrapped lines don't throw it off.
  const visible =
    scroll.scrollHeight > 0
      ? {
          top: (scroll.top / scroll.scrollHeight) * mapHeight - mapTop,
          height: Math.max(6, (scroll.height / scroll.scrollHeight) * mapHeight),
        }
      : { top: 0, height: 0 }

  return (
    <div
      ref={hostRef}
      className={cn(
        'relative w-16 flex-none cursor-pointer overflow-hidden border-l bg-secondary/40 text-foreground select-none',
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      aria-hidden
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div
        className="absolute inset-x-0 bg-foreground/10 ring-1 ring-foreground/15 ring-inset"
        style={{ top: visible.top, height: visible.height }}
      />
    </div>
  )
}
