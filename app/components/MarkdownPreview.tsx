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
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  List,
  Maximize2,
  Minimize2,
  Search,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { readBinaryFile } from '@/app/actions/github'
import {
  COPY_BUTTON_ATTR,
  COPY_SOURCE_ATTR,
  SOURCE_LINE_ATTR,
  renderMarkdown,
  type MarkdownHeading,
  type MarkdownPart,
  type MarkdownRepoLocator,
} from '@/lib/markdown'
import {
  clearFindHighlights,
  FIND_HIGHLIGHT,
  FIND_ACTIVE_HIGHLIGHT,
  findRanges,
  paintFindHighlights,
  scrollRangeIntoView,
} from '@/lib/findInDocument'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import { isDiagramFile } from '@/lib/tree'
import DiagramViewport from './DiagramViewport'
import FileHoverCard from './FileHoverCard'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// Pass these valid selectors straight to the browser: the build's CSS parser
// warns on ::highlight(). Keep this plain React style text, not styled-jsx.
const findHighlightStyles = `
::highlight(${FIND_HIGHLIGHT}) {
  background-color: color-mix(in srgb, var(--color-amber-400, #fbbf24) 55%, transparent);
  color: var(--foreground);
}
::highlight(${FIND_ACTIVE_HIGHLIGHT}) {
  background-color: var(--color-amber-400, #fbbf24);
  color: #000;
}
`

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
  onOpenFile?: (path: string, scrollTop: number) => void
  /** Offset to apply when a link navigation changes `path`: zero when moving
   *  forward, or the saved position when returning. */
  navigationScrollTop?: number
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

/** The document half of the editor ↔ preview scroll sync. */
export interface MarkdownPreviewHandle {
  /** Scroll to the block that owns `line` in the source. */
  revealLine: (line: number) => void
}

/** How far below the top of the reading pane a synced block is parked, so it
 *  doesn't sit flush against the edge (or under the window controls). */
const SYNC_SCROLL_OFFSET = 24

/** The deepest rendered block that starts at or before `line`. */
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

/** How long the preview outlives the pointer leaving the link — or leaving the card. */
const HOVER_CLOSE_MS = 160

/** Distance from the top of the reading pane at which a heading counts as "the
 *  one you're reading" for the outline's active marker. */
const ACTIVE_HEADING_OFFSET = 72

/** How long a copied block shows its tick. Matches `DiagramViewport`, which
 *  offers the same action for a top-level diagram. */
const COPIED_FEEDBACK_MS = 1400

/** Where a find match is parked below the top of the reading pane — clear of the
 *  floating search bar, which sits over the document. */
const FIND_SCROLL_OFFSET = 96

/** An in-repo link the pointer is resting on. */
interface HoverTarget {
  path: string
  anchor: HTMLElement
}

/** Rendered markdown, beside the editor exactly like the diagram preview. */
export default function MarkdownPreview({
  text,
  paintBackground = true,
  config = null,
  path = null,
  repo = null,
  onOpenFile,
  navigationScrollTop = 0,
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
    () => ({
      config,
      basePath: path,
      repo,
      resolveImage: repo ? async (imagePath: string) => {
        const result = await readBinaryFile(repo.owner, repo.name, imagePath, repo.branch)
        if (!result.ok) {
          toast.error(`Could not render ${imagePath}: ${result.error.message}`)
          return null
        }
        const extension = imagePath.split('.').pop()?.toLowerCase()
        const mime = extension === 'svg' ? 'image/svg+xml'
          : extension === 'jpg' ? 'image/jpeg'
            : extension === 'gif' ? 'image/gif' : 'image/png'
        return `data:${mime};base64,${result.data.content}`
      } : undefined,
    }),
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

  /** One stable `dangerouslySetInnerHTML` wrapper per prose run, rebuilt only when `parts` is. */
  const runHtml = useMemo(
    () => parts.map((part) => ({ __html: part.type === 'html' ? part.html : '' })),
    [parts],
  )

  const [isMaximized, setIsMaximized] = useState(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** The document column — the subtree find-in-page searches. Narrower than
   *  `scrollRef` on purpose: the outline panel is inside the scroller too, and
   *  matching the table of contents would double every heading hit. */
  const documentRef = useRef<HTMLDivElement | null>(null)

  // A linked document starts at the top. Returning through the link trail
  // supplies the position that document had before the reader left it.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = navigationScrollTop
  }, [path, navigationScrollTop])

  /* ---------------------------------------------------------------- */
  /* Find in document (full-window reading view)                       */
  /* ---------------------------------------------------------------- */

  /**
   * Search, offered only in the reading view. Deliberately not beside the editor: that pane has the
   * source next to it and CodeMirror's own ⌘F, which searches the thing you would then edit.
   */
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)
  const [findCount, setFindCount] = useState(0)
  const findRangesRef = useRef<Range[]>([])
  const findInputRef = useRef<HTMLInputElement | null>(null)

  const closeFind = useCallback(() => {
    setFindOpen(false)
    setFindQuery('')
    setFindIndex(0)
    setFindCount(0)
    findRangesRef.current = []
    clearFindHighlights()
  }, [])

  // Re-match whenever the query or the rendered document changes. `parts` is in
  // the deps because an edit on the other side of the split re-renders this one,
  // and ranges into replaced nodes point at a DOM that is no longer on screen.
  useEffect(() => {
    if (!findOpen || !isMaximized) return
    const root = documentRef.current
    if (!root) return
    const ranges = findRanges(root, findQuery)
    findRangesRef.current = ranges
    setFindCount(ranges.length)
    // Keep the reader near where they were as they keep typing, rather than
    // sending them back to the top of the document on every keystroke.
    setFindIndex((prev) => (ranges.length === 0 ? 0 : Math.min(prev, ranges.length - 1)))
  }, [findOpen, isMaximized, findQuery, parts])

  // Paint, and bring the current match into view. Split from the matching effect
  // so stepping through hits doesn't re-run the search.
  useEffect(() => {
    const ranges = findRangesRef.current
    const active = ranges[findIndex] ?? null
    paintFindHighlights(ranges, active)
    const container = scrollRef.current
    if (container && active) {
      scrollRangeIntoView(container, active, FIND_SCROLL_OFFSET)
    }
  }, [findIndex, findCount, isMaximized])

  // Highlights are global to the page, so they have to go when this pane stops
  // showing them — closing the reading view included, which `closeFind` is not
  // called for.
  useEffect(() => {
    if (!findOpen || !isMaximized) clearFindHighlights()
  }, [findOpen, isMaximized])
  useEffect(() => clearFindHighlights, [])

  const stepFind = useCallback((delta: number) => {
    const total = findRangesRef.current.length
    if (total === 0) return
    // Wraps, because a reader at the last match wants the first one next, not a
    // button that stops working.
    setFindIndex((prev) => (prev + delta + total) % total)
  }, [])

  const openFind = useCallback(() => setFindOpen(true), [])

  /** Put the caret in the find field as it appears. */
  useEffect(() => {
    if (!findOpen) return
    findInputRef.current?.focus()
    findInputRef.current?.select()
  }, [findOpen])

  // ⌘F opens the search box, and Escape peels one layer at a time: the search
  // first, the reading view only once there is no search left to close. Escape
  // leaving both at once would dismiss a full-window document on the keystroke
  // the reader meant as "stop searching".
  useEffect(() => {
    if (!isMaximized) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyF' && !e.altKey) {
        e.preventDefault()
        openFind()
        return
      }
      if (e.key !== 'Escape') return
      if (findOpen) closeFind()
      else setIsMaximized(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMaximized, openFind, findOpen, closeFind])

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
    container.scrollTo({ top })
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
        container.scrollTo({ top })
        // A moment of emphasis, because a jump that lands mid-document leaves no
        // clue which of the blocks now on screen was the one asked for.
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
  /** The path the pointer is resting on, tracked beside the node itself. */
  const hoveredPathRef = useRef<string | null>(null)
  const hoverTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  // Identity-stable: setting null when it is already null lets React bail out
  // instead of re-rendering the whole document on every stray mouse event.
  const hide = useCallback(() => setHover((prev) => (prev === null ? prev : null)), [])

  const closeHover = useCallback(() => {
    clearHoverTimer()
    cancelClose()
    hoveredLinkRef.current = null
    hoveredPathRef.current = null
    hide()
  }, [clearHoverTimer, cancelClose, hide])

  /** Close after the grace window rather than now. */
  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current !== null) return
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      closeHover()
    }, HOVER_CLOSE_MS)
  }, [closeHover])

  useEffect(() => {
    return () => {
      clearHoverTimer()
      cancelClose()
    }
  }, [clearHoverTimer, cancelClose])

  const onPointerOver = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!repo) return
      const target = e.target as HTMLElement | null
      const found = target?.closest?.('a[data-md-repo-link]') ?? null
      const link = found instanceof HTMLElement ? found : null
      // Still on (or back on) the link this card belongs to: keep it, and call off
      // any close the trip away scheduled.
      if (link === hoveredLinkRef.current) {
        cancelClose()
        return
      }
      if (!link) {
        scheduleClose()
        return
      }
      const linkPath = link.dataset.mdRepoLink
      if (!linkPath) return
      // The same link, re-rendered into a new element under a pointer that never
      // moved (see `hoveredPathRef`). Adopt the node and leave everything else —
      // whatever is on screen or already on its way is still the right preview.
      if (linkPath === hoveredPathRef.current) {
        hoveredLinkRef.current = link
        setHover((prev) => prev && prev.anchor !== link ? { ...prev, anchor: link } : prev)
        cancelClose()
        return
      }
      // A genuinely different link. Its preview is a fetch and a delay away, so
      // drop the one on screen now rather than leaving the wrong file under the
      // pointer.
      clearHoverTimer()
      cancelClose()
      hide()
      hoveredLinkRef.current = link
      hoveredPathRef.current = linkPath
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null
        setHover({ path: linkPath, anchor: link })
      }, HOVER_DELAY_MS)
    },
    [repo, scheduleClose, cancelClose, clearHoverTimer, hide],
  )

  /** Copy a code block or an embedded diagram's source. */
  const onCopyClick = useCallback((button: HTMLElement) => {
    const holder = button.closest(`[${COPY_SOURCE_ATTR}]`)
    const source = holder?.getAttribute(COPY_SOURCE_ATTR)
    if (source === null || source === undefined) return
    void navigator.clipboard.writeText(source).then(
      () => {
        holder?.classList.add('md-copied')
        window.setTimeout(() => holder?.classList.remove('md-copied'), COPIED_FEEDBACK_MS)
      },
      () => toast.error('Could not write to the clipboard.'),
    )
  }, [])

  const onClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null

      const copyButton = target?.closest?.(`[${COPY_BUTTON_ATTR}]`)
      if (copyButton instanceof HTMLElement) {
        e.preventDefault()
        onCopyClick(copyButton)
        return
      }

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
        onOpenFile(repoPath, scrollRef.current?.scrollTop ?? 0)
        return
      }
      // Nothing here can open the file: with a repo connected the `href` is its
      // GitHub page, which is a reasonable destination. Without one it is still
      // the raw relative path, which would navigate away from the editor.
      if (!repo) e.preventDefault()
    },
    [onOpenFile, repo, scrollToHeading, closeHover, onCopyClick],
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
      <style>{findHighlightStyles}</style>
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
          <p className="px-2 pb-2 text-sm font-medium text-muted-foreground">Contents</p>
          {headings.map((heading) => (
            <Tooltip key={heading.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => scrollToHeading(heading.id)}
                  className={cn(
                    'block w-full truncate rounded-md px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground',
                    activeHeading === heading.id
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground',
                  )}
                  style={{ paddingLeft: `${0.5 + Math.min(heading.level - 1, 3) * 0.75}rem` }}
                >
                  {heading.text}
                </button>
              </TooltipTrigger>
              <TooltipContent>{heading.text}</TooltipContent>
            </Tooltip>
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
              ref={documentRef}
              className={cn('mx-auto max-w-3xl px-8 pb-10', isMaximized ? 'pt-24' : 'pt-6')}
              onClick={onClick}
              onDoubleClick={onDoubleClick}
              onMouseOver={onPointerOver}
              onMouseLeave={scheduleClose}
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
                      source={part.source}
                      variant="embedded"
                      background={surface}
                      sourceLine={part.line}
                    />
                  ) : (
                    <div
                      key={i}
                      className="md-prose-run"
                      // eslint-disable-next-line react/no-danger
                      dangerouslySetInnerHTML={runHtml[i]}
                    />
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* The search bar takes the toolbar's place while it is open rather than
          sitting beside it: at this width the two together would reach halfway
          across the document, and every control the toolbar holds is either
          irrelevant while searching (the outline) or a way to leave the view the
          search belongs to. */}
      {isMaximized && findOpen ? (
        <div className="absolute top-3 right-4 flex items-center gap-1 rounded-lg border bg-card/90 p-1 shadow-sm backdrop-blur supports-backdrop-filter:bg-card/75">
          <Search className="ml-1.5 size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value)
              // A new query starts at the first hit; keeping the old index would
              // land the reader in the middle of a different set of matches.
              setFindIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                stepFind(e.shiftKey ? -1 : 1)
              }
            }}
            placeholder="Find in document"
            aria-label="Find in document"
            className="h-7 w-48 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          <span className="min-w-14 shrink-0 px-1 text-right text-xs tabular-nums text-muted-foreground">
            {findQuery.trim() === ''
              ? ''
              : findCount === 0
                ? 'No results'
                : `${findIndex + 1} of ${findCount}`}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => stepFind(-1)}
            disabled={findCount === 0}
            title="Previous match (⇧ Enter)"
            aria-label="Previous match"
          >
            <ChevronUp />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => stepFind(1)}
            disabled={findCount === 0}
            title="Next match (Enter)"
            aria-label="Next match"
          >
            <ChevronDown />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={closeFind}
            title="Close find (Esc)"
            aria-label="Close find"
          >
            <X />
          </Button>
        </div>
      ) : null}

      <div
        className={cn(
          'absolute top-3 right-4 flex items-center gap-1 rounded-lg border bg-card/80 p-1 shadow-sm backdrop-blur supports-backdrop-filter:bg-card/60',
          isMaximized && findOpen && 'hidden',
        )}
      >
        {isMaximized ? (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={openFind}
            title="Find in document (⌘F)"
            aria-label="Find in document"
          >
            <Search />
          </Button>
        ) : null}
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
        <FileHoverCard
          repo={repo}
          path={hover.path}
          anchor={hover.anchor}
          config={config}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
        />
      ) : null}
    </div>
  )
}
