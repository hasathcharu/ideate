'use client'

import dynamic from 'next/dynamic'
import { Loader2 } from 'lucide-react'
import type { CanvasInnerProps } from './CanvasInner'

declare global {
  interface Window {
    /** Base URL Excalidraw resolves its lazily-loaded font subsets against.
     *  Unset, it falls back to a public CDN. */
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

/**
 * Where the vendored Excalidraw fonts live. `scripts/vendor-excalidraw-assets.mjs`
 * copies them into `public/excalidraw-assets/fonts/` on install and build; the
 * library appends `./fonts/...` to this base, so the trailing slash matters.
 */
const ASSET_PATH = '/excalidraw-assets/'

/**
 * The Excalidraw canvas, split out behind a dynamic import.
 *
 * `ssr: false` isn't optional: Excalidraw touches `window` at module scope and
 * renders to a real canvas, the same reason `Editor`/`Preview` are client-only
 * (see rule 5 in CLAUDE.md). Deferring it also keeps the editor bundle — around
 * a megabyte, plus 13MB of lazily-fetched fonts — out of the path for users who
 * only open mermaid diagrams.
 *
 * The asset path is set inside the import factory rather than at module scope so
 * it's guaranteed to be in place before Excalidraw's font registry initializes.
 */
const CanvasInner = dynamic(
  async () => {
    if (typeof window !== 'undefined' && window.EXCALIDRAW_ASSET_PATH === undefined) {
      window.EXCALIDRAW_ASSET_PATH = ASSET_PATH
    }
    return (await import('./CanvasInner')).default
  },
  {
    ssr: false,
    loading: () => (
      <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading canvas…
      </div>
    ),
  },
)

export type CanvasProps = CanvasInnerProps

export default function Canvas(props: CanvasProps) {
  return <CanvasInner {...props} />
}
