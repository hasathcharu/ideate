'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { renderMarkdown, type MarkdownPart } from '@/lib/markdown'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import DiagramViewport from './DiagramViewport'
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
}

/**
 * Rendered markdown, beside the editor exactly like the diagram preview.
 *
 * Unlike `Preview`, this is a *document*: it scrolls rather than zooming and
 * panning, and it gets a measured column width instead of filling the pane edge
 * to edge. The embedded diagrams still scale down to that column (see the
 * `.md-prose .md-mermaid svg` rule in globals.css).
 */
export default function MarkdownPreview({
  text,
  paintBackground = true,
  config = null,
}: MarkdownPreviewProps) {
  // Client-only for the same reason as the diagram preview: rendering the
  // embedded mermaid fences measures text against the live DOM.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Rendering is async (each mermaid fence is an await), so a fast edit can land
  // while an earlier render is still in flight — drop superseded results.
  const [parts, setParts] = useState<MarkdownPart[]>([])
  useEffect(() => {
    if (!mounted) return
    let cancelled = false
    void renderMarkdown(text, config).then((result) => {
      if (!cancelled) setParts(result)
    })
    return () => {
      cancelled = true
    }
  }, [text, config, mounted])

  const [isMaximized, setIsMaximized] = useState(false)
  useEffect(() => {
    if (!isMaximized) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMaximized(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMaximized])

  const themeBackground =
    typeof config?.themeVariables?.background === 'string'
      ? config.themeVariables.background
      : undefined

  const wrapperStyle: CSSProperties = {
    background: paintBackground ? (themeBackground ?? '#ffffff') : 'transparent',
  }

  const isEmpty = !text.trim()

  return (
    <div
      className={cn(
        'relative',
        isMaximized ? 'fixed inset-0 z-50 h-screen w-screen' : 'h-full w-full',
      )}
      style={wrapperStyle}
    >
      <div className="h-full w-full overflow-auto">
        {isEmpty ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Start typing on the left to see your document here.
          </div>
        ) : (
          <div className="mx-auto max-w-3xl px-8 py-6">
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
                    background={themeBackground}
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

      <div className="absolute top-2 right-2 flex items-center gap-1 rounded-lg border bg-card/80 p-1 shadow-sm backdrop-blur supports-backdrop-filter:bg-card/60">
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
