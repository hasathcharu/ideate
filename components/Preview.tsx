'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { Maximize2, Minimize2, Scan, ZoomIn, ZoomOut } from 'lucide-react'
import type { DiagramColors } from 'beautiful-mermaid'
import { renderPreview, colorsToCssVars } from '@/lib/mermaid'
import { Button } from '@/components/ui/button'

export interface PreviewProps {
  text: string
  colors: DiagramColors | null
  /** Paint the theme background behind the diagram (vs. transparent). */
  paintBackground?: boolean
}

interface View {
  scale: number
  x: number
  y: number
}

const MIN_SCALE = 0.1
const MAX_SCALE = 8
const FIT_PADDING = 32

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

export default function Preview({ text, colors, paintBackground = true }: PreviewProps) {
  // The preview is client-only (per the architecture): rendering it during SSR
  // would both violate that and mis-measure sequence-diagram labels (text
  // measurement needs the browser). Gate on mount so the SVG is only built once
  // `document` — and canvas text metrics — are available.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Rendered once per source change; theme switches never re-render — they only
  // change the CSS custom properties on the wrapper below.
  const result = useMemo(() => (mounted ? renderPreview(text) : null), [text, mounted])

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const svgHostRef = useRef<HTMLDivElement | null>(null)
  const naturalRef = useRef({ w: 0, h: 0 })
  // Once the user zooms/pans, stop auto-refitting on resize so we don't fight them.
  const interactedRef = useRef(false)
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null)

  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Mirror of the latest view for imperative reads (pointer drag start).
  const viewRef = useRef(view)
  viewRef.current = view

  const styleVars = colors ? colorsToCssVars(colors) : {}
  const wrapperStyle: CSSProperties = {
    ...(styleVars as CSSProperties),
    background: paintBackground && colors ? colors.bg : 'transparent',
  }

  /** Center the diagram and scale it to fit the viewport (never upscaling). */
  const fit = useCallback(() => {
    const vp = viewportRef.current
    const { w, h } = naturalRef.current
    if (!vp || !w || !h) return
    const rect = vp.getBoundingClientRect()
    const s = clampScale(
      Math.min(
        (rect.width - FIT_PADDING * 2) / w,
        (rect.height - FIT_PADDING * 2) / h,
        1,
      ),
    )
    setView({ scale: s, x: (rect.width - w * s) / 2, y: (rect.height - h * s) / 2 })
    interactedRef.current = false
  }, [])

  // Measure the freshly rendered SVG and fit it.
  useLayoutEffect(() => {
    const svg = svgHostRef.current?.querySelector('svg')
    if (!svg) return
    const wAttr = parseFloat(svg.getAttribute('width') ?? '')
    const hAttr = parseFloat(svg.getAttribute('height') ?? '')
    if (wAttr && hAttr) {
      naturalRef.current = { w: wAttr, h: hAttr }
    } else {
      const bb = svg.getBoundingClientRect()
      naturalRef.current = { w: bb.width, h: bb.height }
    }
    // Fit to screen whenever the diagram changes (fresh render). `fit()` clears
    // the interacted flag, so a subsequent resize won't refit until the user
    // pans/zooms again.
    fit()
  }, [result, fit])

  // Refit on viewport resize, but only while the user hasn't taken control.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const ro = new ResizeObserver(() => {
      if (!interactedRef.current) fit()
    })
    ro.observe(vp)
    return () => ro.disconnect()
  }, [fit])

  // Track fullscreen state (via the Fullscreen API on the viewport element).
  useEffect(() => {
    const onChange = () => {
      const fs = document.fullscreenElement === viewportRef.current
      setIsFullscreen(fs)
      // Give layout a tick to settle, then refit to the new size.
      requestAnimationFrame(() => {
        if (!interactedRef.current) fit()
      })
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [fit])

  /** Zoom by `factor` keeping the point (cx, cy) in viewport space fixed. */
  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    interactedRef.current = true
    setView((v) => {
      const scale = clampScale(v.scale * factor)
      const k = scale / v.scale
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
    })
  }, [])

  const zoomFromCenter = useCallback(
    (factor: number) => {
      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect) return
      zoomAt(rect.width / 2, rect.height / 2, factor)
    },
    [zoomAt],
  )

  /** Reset to 100% (1:1) about the viewport center. */
  const resetZoom = useCallback(() => {
    zoomFromCenter(1 / viewRef.current.scale)
  }, [zoomFromCenter])

  // Native, non-passive wheel listener so we can preventDefault the page scroll.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = vp.getBoundingClientRect()
      const factor = Math.exp(-e.deltaY * 0.0015)
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor)
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    interactedRef.current = true
    dragRef.current = {
      px: e.clientX,
      py: e.clientY,
      x: viewRef.current.x,
      y: viewRef.current.y,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    setView((v) => ({ ...v, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }))
  }, [])

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      dragRef.current = null
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    }
  }, [])

  const toggleFullscreen = useCallback(() => {
    const vp = viewportRef.current
    if (!vp) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void vp.requestFullscreen()
  }, [])

  return (
    <div
      ref={viewportRef}
      className="preview-zoom relative h-full w-full overflow-hidden"
      style={wrapperStyle}
    >
      {!result ? null : result.ok ? (
        <>
          <div
            className="absolute inset-0 cursor-grab active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={fit}
          >
            <div
              ref={svgHostRef}
              className="preview-svg absolute top-0 left-0 origin-top-left"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: result.svg }}
            />
          </div>

          <div className="absolute top-2 right-2 flex items-center gap-1 rounded-lg border bg-card/80 p-1 shadow-sm backdrop-blur supports-backdrop-filter:bg-card/60">
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => zoomFromCenter(1 / 1.2)}
              title="Zoom out"
            >
              <ZoomOut />
            </Button>
            <button
              type="button"
              onClick={resetZoom}
              onDoubleClick={fit}
              className="min-w-11 rounded px-1 text-center text-xs tabular-nums text-muted-foreground hover:text-foreground"
              title="Reset to 100% (double-click to fit)"
            >
              {Math.round(view.scale * 100)}%
            </button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => zoomFromCenter(1.2)}
              title="Zoom in"
            >
              <ZoomIn />
            </Button>
            <span className="mx-0.5 h-4 w-px bg-border" />
            <Button size="icon-xs" variant="ghost" onClick={fit} title="Fit to screen">
              <Scan />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit full screen' : 'Full screen'}
            >
              {isFullscreen ? <Minimize2 /> : <Maximize2 />}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-md text-sm text-destructive">
            <strong>Can&rsquo;t render diagram</strong>
            <pre className="mt-2 rounded-md border border-border bg-black/25 p-2.5 whitespace-pre-wrap text-muted-foreground">
              {result.message}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
