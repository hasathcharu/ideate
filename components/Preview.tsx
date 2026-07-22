'use client'

import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import type { DiagramColors } from 'beautiful-mermaid'
import { renderPreview, colorsToCssVars } from '@/lib/mermaid'

export interface PreviewProps {
  text: string
  colors: DiagramColors | null
  /** Paint the theme background behind the diagram (vs. transparent). */
  paintBackground?: boolean
}

export default function Preview({
  text,
  colors,
  paintBackground = true,
}: PreviewProps) {
  // Rendered once per source change; theme switches never re-render — they only
  // change the CSS custom properties on the wrapper below.
  const result = useMemo(() => renderPreview(text), [text])

  const styleVars = colors ? colorsToCssVars(colors) : {}
  const wrapperStyle: CSSProperties = {
    ...(styleVars as CSSProperties),
    background: paintBackground && colors ? colors.bg : 'transparent',
  }

  return (
    <div
      className="flex h-full items-center justify-center overflow-auto p-6"
      style={wrapperStyle}
    >
      {result.ok ? (
        <div
          className="preview-svg"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: result.svg }}
        />
      ) : (
        <div className="max-w-md text-sm text-destructive">
          <strong>Can&rsquo;t render diagram</strong>
          <pre className="mt-2 rounded-md border border-border bg-black/25 p-2.5 whitespace-pre-wrap text-muted-foreground">
            {result.message}
          </pre>
        </div>
      )}
    </div>
  )
}
