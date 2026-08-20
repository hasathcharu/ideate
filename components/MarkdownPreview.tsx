'use client'

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { ArrowLeft, List, Maximize2, Minimize2 } from 'lucide-react'
import {
  SOURCE_LINE_ATTR,
  renderMarkdown,
  type MarkdownHeading,
  type MarkdownPart,
  type MarkdownRepoLocator,
} from '@/lib/markdown'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import { isDiagramFile } from '@/lib/tree'
import DiagramViewport from './DiagramViewport'
import FileHoverCard from './FileHoverCard'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface MarkdownPreviewProps {
  text: string
  /** Paint the active theme's background behind the document (vs. transparent). */
  paintBackground?: boolean
  /** Global mermaid config — drives both the app palette and the embedded
   *  diagrams, which are rendered with it at preview time and never carry it in
   *  the file itself. */
  config?: MermaidUserConfig | null
  /** Repo-relative path of the document being previewed. Relative links and
   *  images resolve against its directory, exactly as they do on GitHub. */
  path?: string | null
  /** The repository the document lives in. Without it, links to other files in
   *  the repo can't be resolved and hover previews can't be fetched. */
  repo?: MarkdownRepoLocator | null
  /** Open another file from the repo in the editor — what a click on an in-repo
   *  link does. Omitted (e.g. the read-only history preview) leaves such links
   *  pointing at their GitHub page. */
  onOpenFile?: (path: string) => void
  /** Go back to the file this one was opened from. Present only when there is
   *  somewhere to go back to; the reading view needs its own copy of this because
   *  filling the window covers the toolbar that otherwise carries it. */
  onBack?: () => void
  /** Path the Back button leads to, for its tooltip. */
  backLabel?: string
  /** Double-clicking a block reports the source line it was written on, so the
   *  editor can jump there. See {@link MarkdownPreviewHandle} for the other
   *  direction. */
  onRevealSource?: (line: number) => void
  /** Handle the app drives to scroll this pane to a source line. */
  ref?: React.Ref<MarkdownPreviewHandle>
}

/**
 * The document half of the editor ↔ preview scroll sync.
 *
 * Imperative rather than a `line` prop for one reason: scrolling is an *event*,
 * not state. As a prop, double-clicking the same line twice — which is exactly
 * what you do after scrolling away — would pass React an unchanged value and
 * nothing would happen, and the usual fix (pairing the line with a nonce) makes
 * every jump re-render the whole document, diagrams included.
 */
export interface MarkdownPreviewHandle {
  /** Scroll to the block that owns `line` in the source. */
  revealLine: (line: number) => void
}

/** How far below the top of the reading pane a synced block is parked, so it
 *  doesn't sit flush against the edge (or under the window controls). */
const SYNC_SCROLL_OFFSET = 24

/**
 * The deepest rendered block that starts at or before `line`.
 *
 * `lib/markdown.ts` stamps every block — nested ones included — so the candidates
 * for line 12 might be a `<blockquote>` on line 9, a `<p>` on line 11 and the
 * `<li>` between them. Document order plus "last one that starts early enough"
 * picks the innermost, because a child always follows its parent in the tree and
 * so appears later in the query result.
 */
function blockForLine(container: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestLine = -Infinity
  for (const el of container.querySelectorAll<HTMLElement>(`[${SOURCE_LINE_ATTR}]`)) {
    const start = Number(el.getAttribute(SOURCE_LINE_ATTR))
    if (!Number.isFinite(start) || start > line) continue
    // `>=` so a later sibling on the same line wins over an earlier one, and a
    // child (which follows its parent) wins over the block containing it.
    if (start >= bestLine) {
      best = el
      bestLine = start
    }
  }
  return best
}

/** How long the pointer has to rest on an in-repo link before its preview is
 *  fetched. Long enough that dragging the mouse across a paragraph of links
 *  doesn't fetch every one of them. */
const HOVER_DELAY_MS = 350

/** Distance from the top of the reading pane at which a heading counts as "the
 *  one you're reading" for the outline's active marker. */
const ACTIVE_HEADING_OFFSET = 72

/** An in-repo link the pointer is resting on. */
interface HoverTarget {
  path: string
  rect: DOMRect
}

/**
 * Rendered markdown, beside the editor exactly like the diagram preview.
 *
 * Unlike `Preview`, this is a *document*: it scrolls rather than zooming and
 * panning, and it gets a measured column width instead of filling the pane edge
 * to edge. The embedded diagrams still scale down to that column (see the
 * `.md-prose .md-mermaid svg` rule in globals.css).
 *
 * Three behaviors here belong to the document rather than to the renderer:
 *
 * - **In-repo links open in the editor.** `lib/markdown.ts` resolves them to a
 *   repo path and tags them; the click handler below intercepts a plain click and
 *   opens the file, while ⌘/Ctrl-click still follows the `href` to GitHub.
 * - **Resting on such a link previews the file** (`FileHoverCard`).
 * - **Filling the window offers the outline**, since a full-screen document is
 *   being *read* rather than edited, and reading one wants a table of contents.
 */
export default function MarkdownPreview({
  text,
  paintBackground = true,
  config = null,
  path = null,
  repo = null,
  onOpenFile,
  onBack,
  backLabel,
  onRevealSource,
  ref,
}: MarkdownPreviewProps) {
  // Client-only for the same reason as the diagram preview: rendering the
  // embedded mermaid fences measures text against the live DOM.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Stable options object, so the render effect doesn't re-run on every parent
  // render just because a fresh object literal was passed down.
  const repoKey = repo ? `${repo.owner}/${repo.name}@${repo.branch}` : null
  const options = useMemo(
    () => ({ config, basePath: path, repo }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, path, repoKey],
  )

  // Rendering is async (each mermaid fence is an await), so a fast edit can land
  // while an earlier render is still in flight — drop superseded results.
  const [parts, setParts] = useState<MarkdownPart[]>([])
  const [headings, setHeadings] = useState<MarkdownHeading[]>([])
  useEffect(() => {
    if (!mounted) return
    let cancelled = false
    void renderMarkdown(text, options).then((result) => {
      if (cancelled) return
      setParts(result.parts)
      setHeadings(result.headings)
    })
    return () => {
      cancelled = true
    }
  }, [text, options, mounted])

  const [isMaximized, setIsMaximized] = useState(false)
  useEffect(() => {
    if (!isMaximized) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMaximized(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMaximized])

  const scrollRef = useRef<HTMLDivElement | null>(null)

  /* ---------------------------------------------------------------- */
  /* Outline (full-window reading view)                                */
  /* ---------------------------------------------------------------- */

  const [outlineOpen, setOutlineOpen] = useState(true)
  const [activeHeading, setActiveHeading] = useState<string | null>(null)
  // The outline is a reading aid: beside the editor the pane is too narrow to
  // spare the width, and the document is right there in the source anyway. It
  // floats at the top right, directly under the window controls, so the panel and
  // the button that opens it are in the same place.
  const showOutline = isMaximized && outlineOpen && headings.length > 1

  const scrollToHeading = useCallback((id: string) => {
    const container = scrollRef.current
    const target = container?.querySelector(`[id="${CSS.escape(id)}"]`)
    if (!container || !target) return
    // Scroll the container, not the page: `scrollIntoView` on a nested scroller
    // also nudges the window when the overlay is only *nearly* full-height.
    const top =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      16
    container.scrollTo({ top, behavior: 'smooth' })
    setActiveHeading(id)
  }, [])

  /* ---------------------------------------------------------------- */
  /* Scroll sync with the editor                                       */
  /* ---------------------------------------------------------------- */

  // Mount-stable: everything it touches is behind `scrollRef`, so the app never
  // has to re-read the handle.
  useImperativeHandle(
    ref,
    () => ({
      revealLine: (line) => {
        const container = scrollRef.current
        const target = container && blockForLine(container, line)
        if (!container || !target) return
        // Scroll the container, not the page — `scrollIntoView` on a nested
        // scroller also nudges the window, the same trap `scrollToHeading` avoids.
        const top =
          target.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop -
          SYNC_SCROLL_OFFSET
        container.scrollTo({ top, behavior: 'smooth' })
        // A moment of emphasis, because a smooth scroll that lands mid-document
        // leaves no clue which of the blocks now on screen was the one asked for.
        target.classList.remove('md-sync-flash')
        // Reading `offsetWidth` restarts the animation: without the reflow the
        // class comes off and goes back on inside one frame and the browser sees
        // no change at all, so double-clicking the same line twice flashes once.
        void target.offsetWidth
        target.classList.add('md-sync-flash')
        window.setTimeout(() => target.classList.remove('md-sync-flash'), 1200)
      },
    }),
    [],
  )

  // Double-clicking a block asks the editor for the line it was written on.
  // Bound on the document wrapper, so it covers the prose runs and the embedded
  // diagrams alike — both carry `data-md-line`.
  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!onRevealSource) return
      const target = e.target as HTMLElement | null
      const block = target?.closest?.(`[${SOURCE_LINE_ATTR}]`)
      if (!(block instanceof HTMLElement)) return
      const line = Number(block.getAttribute(SOURCE_LINE_ATTR))
      if (Number.isFinite(line)) onRevealSource(line)
    },
    [onRevealSource],
  )

  // Track which heading is currently at the top of the reading pane. Only while
  // the outline is on screen — there is nothing to highlight otherwise.
  useEffect(() => {
    const container = scrollRef.current
    if (!showOutline || !container) return
    let frame = 0
    const measure = () => {
      frame = 0
      const threshold = container.getBoundingClientRect().top + ACTIVE_HEADING_OFFSET
      let current: string | null = null
      for (const el of container.querySelectorAll<HTMLElement>('.md-heading[id]')) {
        if (el.getBoundingClientRect().top <= threshold) current = el.id
        else break
      }
      setActiveHeading(current ?? headings[0]?.id ?? null)
    }
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(measure)
    }
    measure()
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [showOutline, headings, parts])

  /* ---------------------------------------------------------------- */
  /* In-repo links                                                     */
  /* ---------------------------------------------------------------- */

  const [hover, setHover] = useState<HoverTarget | null>(null)
  const hoveredLinkRef = useRef<HTMLElement | null>(null)
  const hoverTimerRef = useRef<number | null>(null)

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  const closeHover = useCallback(() => {
    clearHoverTimer()
    hoveredLinkRef.current = null
    // Identity-stable: setting null when it is already null lets React bail out
    // instead of re-rendering the whole document on every stray mouse event.
    setHover((prev) => (prev === null ? prev : null))
  }, [clearHoverTimer])

  useEffect(() => clearHoverTimer, [clearHoverTimer])

  // The card is placed from the link's screen rect, so scrolling has to move it.
  // Re-measuring rather than dismissing matters for more than smoothness: closing
  // it on scroll while the pointer still rests on the link left the next mouse
  // event free to schedule it all over again, which is a flicker loop.
  useEffect(() => {
    if (!hover) return
    const container = scrollRef.current
    const remeasure = () => {
      const link = hoveredLinkRef.current
      if (!link?.isConnected) {
        closeHover()
        return
      }
      const rect = link.getBoundingClientRect()
      setHover((prev) =>
        prev && (prev.rect.top !== rect.top || prev.rect.left !== rect.left)
          ? { ...prev, rect }
          : prev,
      )
    }
    container?.addEventListener('scroll', remeasure, { passive: true })
    return () => container?.removeEventListener('scroll', remeasure)
  }, [hover, closeHover])

  const onPointerOver = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!repo) return
      const target = e.target as HTMLElement | null
      const found = target?.closest?.('a[data-md-repo-link]') ?? null
      const link = found instanceof HTMLElement ? found : null
      if (link === hoveredLinkRef.current) return
      if (!link) {
        closeHover()
        return
      }
      clearHoverTimer()
      hoveredLinkRef.current = link
      const linkPath = link.dataset.mdRepoLink
      if (!linkPath) return
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null
        setHover({ path: linkPath, rect: link.getBoundingClientRect() })
      }, HOVER_DELAY_MS)
    },
    [repo, closeHover, clearHoverTimer],
  )

  const onClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null
      const anchor = target?.closest?.('a')
      if (!(anchor instanceof HTMLAnchorElement)) return

      // An in-document anchor (`#heading`, including the permalink beside every
      // heading) scrolls the reading pane instead of navigating the app.
      const href = anchor.getAttribute('href') ?? ''
      if (href.startsWith('#')) {
        e.preventDefault()
        scrollToHeading(decodeURIComponent(href.slice(1)))
        return
      }

      const repoPath = anchor.dataset.mdRepoLink
      if (!repoPath) return
      const modified = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey
      if (!modified && onOpenFile && isDiagramFile(repoPath)) {
        e.preventDefault()
        closeHover()
        onOpenFile(repoPath)
        return
      }
      // Nothing here can open the file: with a repo connected the `href` is its
      // GitHub page, which is a reasonable destination. Without one it is still
      // the raw relative path, which would navigate away from the editor.
      if (!repo) e.preventDefault()
    },
    [onOpenFile, repo, scrollToHeading, closeHover],
  )

  const themeBackground =
    typeof config?.themeVariables?.background === 'string'
      ? config.themeVariables.background
      : undefined

  // One resolved surface color for the whole pane — the document behind the prose
  // and the box behind each embedded diagram. Resolving it here (rather than
  // handing `DiagramViewport` a possibly-undefined theme color) is what keeps a
  // maximized diagram opaque; the two can no longer disagree about the surface.
  const surface = paintBackground ? (themeBackground ?? '#ffffff') : 'transparent'
  const wrapperStyle: CSSProperties = { background: surface }

  const isEmpty = !text.trim()

  return (
    <div
      className={cn(
        'relative',
        isMaximized ? 'fixed inset-0 z-50 h-screen w-screen' : 'h-full w-full',
      )}
      style={wrapperStyle}
    >
      {/* The outline floats over the document rather than taking a column of it:
          the prose stays centred where it was, and opening the panel doesn't
          re-lay-out (and re-fit) every diagram in the document. */}
      {showOutline ? (
        <nav
          aria-label="Document outline"
          // `space-y-px`: the active entry is tinted and every entry has a hover
          // fill, both full-width rounded rectangles — flush against each other
          // they merged into one block whenever the hovered entry sat beside the
          // active one.
          className="absolute top-14 right-4 z-10 hidden max-h-[calc(100%-4.5rem)] w-64 space-y-px overflow-auto rounded-lg border bg-card/90 p-2 shadow-lg backdrop-blur sm:block supports-backdrop-filter:bg-card/75"
        >
          <p className="px-2 pb-2 text-xs font-medium text-muted-foreground">Contents</p>
          {headings.map((heading) => (
            <button
              key={heading.id}
              type="button"
              onClick={() => scrollToHeading(heading.id)}
              className={cn(
                'block w-full truncate rounded-md px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground',
                activeHeading === heading.id
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground',
              )}
              style={{ paddingLeft: `${0.5 + Math.min(heading.level - 1, 3) * 0.75}rem` }}
              title={heading.text}
            >
              {heading.text}
            </button>
          ))}
        </nav>
      ) : null}

      <div className="flex h-full w-full">
        <div ref={scrollRef} className="h-full min-w-0 flex-1 overflow-auto">
          {isEmpty ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
              Start typing on the left to see your document here.
            </div>
          ) : (
            <div
              className="mx-auto max-w-3xl px-8 py-6"
              onClick={onClick}
              onDoubleClick={onDoubleClick}
              onMouseOver={onPointerOver}
              onMouseLeave={closeHover}
            >
              {/* Prose runs and diagrams are siblings, so React owns every diagram
                  outright — no portal into markup it doesn't control. The HTML runs
                  are wrapped in `display: contents` spans (see globals.css) so the
                  `.md-prose` child selectors still see the real elements. */}
              <div className="md-prose">
                {parts.map((part, i) =>
                  part.type === 'diagram' ? (
                    <DiagramViewport
                      key={i}
                      className="md-mermaid"
                      svg={part.svg}
                      variant="embedded"
                      background={surface}
                      sourceLine={part.line}
                    />
                  ) : (
                    <div
                      key={i}
                      className="md-prose-run"
                      // eslint-disable-next-line react/no-danger
                      dangerouslySetInnerHTML={{ __html: part.html }}
                    />
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="absolute top-3 right-4 flex items-center gap-1 rounded-lg border bg-card/80 p-1 shadow-sm backdrop-blur supports-backdrop-filter:bg-card/60">
        {isMaximized && onBack ? (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onBack}
            title={backLabel ? `Back to ${backLabel}` : 'Back'}
            aria-label={backLabel ? `Back to ${backLabel}` : 'Back'}
          >
            <ArrowLeft />
          </Button>
        ) : null}
        {isMaximized && headings.length > 1 ? (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setOutlineOpen((v) => !v)}
            aria-pressed={outlineOpen}
            title={outlineOpen ? 'Hide contents' : 'Show contents'}
          >
            <List />
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

      {hover && repo ? (
        <FileHoverCard repo={repo} path={hover.path} anchor={hover.rect} config={config} />
      ) : null}
    </div>
  )
}
