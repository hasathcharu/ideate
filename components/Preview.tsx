'use client'

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  renderPreview,
  type RenderError,
  type RenderResult,
} from '@/lib/mermaid'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import DiagramViewport from './DiagramViewport'

export interface PreviewProps {
  text: string
  /** Paint a solid background behind the diagram (vs. transparent). */
  paintBackground?: boolean
  /** Global mermaid config (theme, layout, per-diagram settings) to render with. */
  config?: MermaidUserConfig | null
}

/**
 * The live diagram pane: mermaid source in, rendered diagram out.
 *
 * The zoom/pan/fit interaction lives in `DiagramViewport`, shared with the
 * diagrams embedded in a markdown document. What stays here is the render
 * lifecycle and the empty/error states, which only the pane has.
 */
export default function Preview({
  text,
  paintBackground = true,
  config = null,
}: PreviewProps) {
  // The preview is client-only (per the architecture): mermaid measures text
  // against the live DOM, so it can only run in the browser. Gate on mount so
  // the SVG is only built once `document` is available.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // mermaid renders asynchronously; keep the latest result in state and ignore
  // any in-flight render that a newer source change has superseded.
  const [result, setResult] = useState<RenderResult | RenderError | null>(null)
  useEffect(() => {
    if (!mounted) return
    let cancelled = false
    void renderPreview(text, config).then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => {
      cancelled = true
    }
  }, [text, config, mounted])
  const isEmpty = !text.trim()

  const themeBackground =
    typeof config?.themeVariables?.background === 'string'
      ? config.themeVariables.background
      : undefined
  const background = paintBackground ? (themeBackground ?? '#ffffff') : 'transparent'

  if (result?.ok) {
    return <DiagramViewport svg={result.svg} background={background} />
  }

  const wrapperStyle: CSSProperties = { background }

  return (
    <div className="relative h-full w-full overflow-hidden" style={wrapperStyle}>
      {!result ? null : isEmpty ? (
        <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Start typing on the left to see your diagram here.
        </div>
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
