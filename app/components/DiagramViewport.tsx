'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { Check, Copy, Maximize2, Minimize2, Scan, ZoomIn, ZoomOut } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useInnerHtml } from '@/lib/hooks'
import { cn } from '@/lib/utils'

/** A zoomable, pannable box around a rendered SVG or repository image. */

interface View {
  scale: number
  x: number
  y: number
}

const MIN_SCALE = 0.1
const MAX_SCALE = 8
const FIT_PADDING = 32
/** Padding for an embedded figure: the box hugs the diagram, so the generous
 *  pane padding would just add dead space in the middle of the prose. */
const EMBEDDED_FIT_PADDING = 12
/** Height bounds for an embedded figure, so one tall diagram can't push the rest
 *  of the document off the screen and a tiny one still has room to be dragged. */
const EMBEDDED_MIN_HEIGHT = 120
const EMBEDDED_MAX_HEIGHT = 460

/** Painted behind a maximized diagram when the caller asked for no background at
 *  all. White rather than `var(--background)` because an untuned diagram renders
 *  in mermaid's own dark-on-light default palette, which would be unreadable on a
 *  dark surface — the same resolution `Preview` and `MarkdownPreview` apply. */
const OPAQUE_FALLBACK = '#ffffff'

/** How long the copy button shows a tick before going back to the copy glyph. */
const COPIED_FEEDBACK_MS = 1400

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

export interface DiagramViewportProps {
  /** Rendered mermaid SVG markup. Omit when `imageSrc` is supplied. */
  svg?: string
  /** Inert image URL for raster files and repository SVGs. */
  imageSrc?: string
  imageAlt?: string
  /** Painted behind the diagram — also fills the screen when maximized. May be
   *  omitted (or `'transparent'`) for an inline figure that should show the
   *  document through it; maximizing then falls back to {@link OPAQUE_FALLBACK}. */
  background?: string
  /** `pane` fills its parent (the editor's preview pane); `embedded` derives its
   *  height from the diagram and sits inline in a document. */
  variant?: 'pane' | 'embedded'
  className?: string
  /**
   * For a diagram embedded in a markdown document: the 1-based source line its ```mermaid fence
   * opens on, published as `data-md-line` so the editor ↔ preview scroll sync can find it alongside
   * the prose blocks, which carry the same attribute (`lib/markdown.ts`).
   */
  sourceLine?: number | null
  /**
   * The mermaid text that produced `svg`. Given one, the toolbar offers to copy it — the source is
   * the half of the pair that can be pasted back into a document, and it is what a reader who wants
   * "this diagram" actually wants.
   */
  source?: string | null
}

export default function DiagramViewport({
  svg,
  imageSrc,
  imageAlt = '',
  background,
  variant = 'pane',
  className,
  sourceLine = null,
  source = null,
}: DiagramViewportProps) {
  const isEmbedded = variant === 'embedded'
  // Acknowledgement for the copy button, since a clipboard write has no other
  // visible effect. Cleared on a timer, and the timer is cleared on unmount.
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    },
    [],
  )

  const copySource = useCallback(async () => {
    if (!source) return
    try {
      await navigator.clipboard.writeText(source)
    } catch {
      toast.error('Could not write to the clipboard.')
      return
    }
    setCopied(true)
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }, [source])

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const svgHostRef = useRef<HTMLDivElement | null>(null)
  // Natural (unscaled) diagram size. Kept in a ref for `fit()`'s synchronous read and mirrored into
  // state so the host box is sized in React-controlled px — this must not depend on mutating the
  // mermaid <svg> node, whose attributes are wiped whenever React re-inserts the
  // dangerouslySetInnerHTML subtree.
  const svgHtml = useInnerHtml(svg ?? '')
  const naturalRef = useRef({ w: 0, h: 0 })
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  // Once the user zooms/pans, stop auto-refitting on resize so we don't fight them.
  const interactedRef = useRef(false)
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null)

  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  // "Maximized" fills the browser window rather than entering real fullscreen: the
  // Fullscreen API takes over the whole screen and hides the browser's own chrome,
  // which is more than is wanted for expanding one diagram. A fixed, inset-0
  // overlay gives the same working area while leaving tabs and the URL bar in place.
  const [isMaximized, setIsMaximized] = useState(false)

  // Mirror of the latest view for imperative reads (pointer drag start).
  const viewRef = useRef(view)
  viewRef.current = view

  /** Center the diagram and scale it to fit the viewport (never upscaling). */
  const fit = useCallback(() => {
    const vp = viewportRef.current
    const { w, h } = naturalRef.current
    if (!vp || !w || !h) return
    const rect = vp.getBoundingClientRect()
    const padding = isEmbedded && !isMaximized ? EMBEDDED_FIT_PADDING : FIT_PADDING
    const s = clampScale(
      Math.min((rect.width - padding * 2) / w, (rect.height - padding * 2) / h, 1),
    )
    setView({ scale: s, x: (rect.width - w * s) / 2, y: (rect.height - h * s) / 2 })
    interactedRef.current = false
  }, [isEmbedded, isMaximized])

  // Measure the freshly rendered SVG.
  useLayoutEffect(() => {
    const el = svgHostRef.current?.querySelector('svg')
    if (!el) return
    // mermaid sizes the SVG with a viewBox plus width="100%" and an inline
    // max-width; read the intrinsic pixel size from the viewBox so we can give
    // the host an explicit box (the SVG then fills it via CSS — see globals.css).
    const vb = el.viewBox?.baseVal
    let w = vb && vb.width && vb.height ? vb.width : parseFloat(el.getAttribute('width') ?? '')
    let h = vb && vb.width && vb.height ? vb.height : parseFloat(el.getAttribute('height') ?? '')
    if (!w || !h) {
      const bb = el.getBoundingClientRect()
      w = bb.width
      h = bb.height
    }
    naturalRef.current = { w, h }
    setNatural({ w, h })
  }, [svg])

  const measureImage = useCallback((image: HTMLImageElement) => {
    const w = image.naturalWidth
    const h = image.naturalHeight
    if (!w || !h) return
    naturalRef.current = { w, h }
    setNatural({ w, h })
  }, [])

  // Fit once the measured size has actually been committed to the DOM — an
  // embedded box takes its height from `natural`, so fitting inside the effect
  // above would measure the *previous* diagram's box.
  useLayoutEffect(() => {
    fit()
  }, [natural, fit])

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

  // Escape leaves the maximized view, matching what real fullscreen did.
  useEffect(() => {
    if (!isMaximized) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMaximized(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMaximized])

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
      // An embedded diagram sits in the middle of a scrolling document, so a bare wheel has to keep
      // scrolling the page — trapping it would make every diagram a scroll dead-zone.
      if (isEmbedded && !isMaximized && !e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const rect = vp.getBoundingClientRect()
      const factor = Math.exp(-e.deltaY * 0.0015)
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor)
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [zoomAt, isEmbedded, isMaximized])

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

  // A maximized viewport is a `fixed inset-0` overlay covering the whole window,
  // so it has to be opaque no matter what the caller asked for. Left transparent
  // (which is what an omitted `background` produced) the editor, the prose and
  // the rest of the page stayed visible around and behind the diagram.
  const surface =
    isMaximized && (!background || background === 'transparent') ? OPAQUE_FALLBACK : background

  const boxStyle: CSSProperties = {}
  if (surface) boxStyle.background = surface
  if (isEmbedded && !isMaximized) {
    boxStyle.height = Math.min(
      EMBEDDED_MAX_HEIGHT,
      Math.max(EMBEDDED_MIN_HEIGHT, natural.h || EMBEDDED_MIN_HEIGHT),
    )
  }
  const contentStyle: CSSProperties = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    width: natural.w || undefined,
    height: natural.h || undefined,
  }

  return (
    <div
      ref={viewportRef}
      data-md-line={sourceLine ?? undefined}
      className={cn(
        'preview-zoom relative overflow-hidden',
        isMaximized
          ? 'fixed inset-0 z-50 h-screen w-screen'
          : isEmbedded
            ? 'group/diagram w-full rounded-lg border'
            : 'h-full w-full',
        className,
      )}
      style={boxStyle}
    >
      <div
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fit}
      >
        {imageSrc ? (
          <div className="absolute top-0 left-0 origin-top-left" style={contentStyle}>
            <img
              src={imageSrc}
              alt={imageAlt}
              draggable={false}
              onLoad={(event) => measureImage(event.currentTarget)}
              className="block h-full w-full max-w-none select-none"
            />
          </div>
        ) : (
          <div
            ref={svgHostRef}
            className="preview-svg absolute top-0 left-0 origin-top-left"
            style={contentStyle}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={svgHtml}
          />
        )}
      </div>

      {/* An embedded figure keeps its controls out of the way until the diagram is
          hovered or focused, so a document full of diagrams isn't a document full
          of toolbars. Maximized, they are always shown — there is nothing else on
          screen to be uncluttered from. */}
      <div
        className={cn(
          'absolute top-2 right-2 flex items-center gap-1 rounded-lg border bg-card/80 p-1 shadow-sm backdrop-blur transition-opacity supports-backdrop-filter:bg-card/60',
          isEmbedded &&
            !isMaximized &&
            'opacity-0 group-hover/diagram:opacity-100 group-focus-within/diagram:opacity-100',
        )}
      >
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
        {source ? (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => void copySource()}
            title={copied ? 'Copied' : 'Copy the mermaid source'}
            aria-label={copied ? 'Copied' : 'Copy the mermaid source'}
          >
            {copied ? <Check className="text-emerald-500" /> : <Copy />}
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => setIsMaximized((v) => !v)}
          title={isMaximized ? 'Exit full window (Esc)' : 'Fill window'}
        >
          {isMaximized ? <Minimize2 /> : <Maximize2 />}
        </Button>
      </div>
    </div>
  )
}
