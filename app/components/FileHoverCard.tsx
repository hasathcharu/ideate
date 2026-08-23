'use client'

import { useEffect, useState } from 'react'
import { readFile } from '@/app/actions/github'
import { renderToSvg } from '@/lib/mermaid'
import { renderMarkdown, type MarkdownPart, type MarkdownRepoLocator } from '@/lib/markdown'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import { fileKind } from '@/lib/tree'
import { sceneSummary } from '@/lib/excalidraw'
import { handleExpiredSession } from '@/lib/sessionExpiry'
import { docIdForFile, loadDraft } from '@/lib/storage'
import { Skeleton } from '@/components/ui/skeleton'
import { ExcalidrawIcon, MarkdownIcon, MermaidIcon } from './icons'

/**
 * The preview that appears when a repo-relative link inside a markdown document
 * is hovered — enough of the linked file to tell whether it's the one you meant,
 * without leaving the document.
 *
 * Three things keep it cheap. Fetches are **cached per repo+branch+path** for the
 * lifetime of the page, since a document usually links the same handful of files
 * repeatedly. The rendered preview is built from a **truncated** copy of the
 * source, so a 3000-line document doesn't get laid out to fill a 300px card. And
 * the card is **`pointer-events: none`** — it is a preview, not a menu, so it
 * never has to negotiate hover with the link that opened it.
 */

/** Longest prefix of a document that gets rendered into the card. Past this the
 *  content is off the bottom of the card anyway. */
const PREVIEW_SOURCE_LIMIT = 1500

/** What a fetch produced, cached so repeated hovers cost nothing. */
type Loaded =
  | { ok: true; content: string }
  | { ok: false; message: string }

const cache = new Map<string, Loaded>()

function cacheKey(repo: MarkdownRepoLocator, path: string): string {
  return `${repo.owner}/${repo.name}@${repo.branch}:${path}`
}

/** First `PREVIEW_SOURCE_LIMIT` characters, cut at a line boundary so the render
 *  doesn't start mid-fence or mid-table. */
function truncateSource(text: string): { source: string; truncated: boolean } {
  if (text.length <= PREVIEW_SOURCE_LIMIT) return { source: text, truncated: false }
  const slice = text.slice(0, PREVIEW_SOURCE_LIMIT)
  const cut = slice.lastIndexOf('\n')
  return { source: cut > 200 ? slice.slice(0, cut) : slice, truncated: true }
}

export interface FileHoverCardProps {
  repo: MarkdownRepoLocator
  /** Repo-relative path of the linked file. */
  path: string
  /** Screen rect of the link, so the card can sit under it. */
  anchor: DOMRect
  config: MermaidUserConfig | null
}

export default function FileHoverCard({ repo, path, anchor, config }: FileHoverCardProps) {
  const key = cacheKey(repo, path)
  const [loaded, setLoaded] = useState<Loaded | null>(() => cache.get(key) ?? null)

  useEffect(() => {
    const cached = cache.get(key)
    if (cached) {
      setLoaded(cached)
      return
    }
    let cancelled = false
    setLoaded(null)
    void readFile(repo.owner, repo.name, path, repo.branch).then((res) => {
      // A never-committed file isn't on the branch, so the read 404s — but the
      // file does exist here, in the sidebar and one click away, and its draft is
      // the only copy. Falling back to it keeps the preview from claiming a file
      // the app will happily open cannot be read. (It doubles as a fallback for a
      // committed file whose read failed and whose working copy we still hold.)
      const draft = res.ok
        ? null
        : loadDraft(docIdForFile(repo.owner, repo.name, repo.branch, path))
      const result: Loaded = res.ok
        ? { ok: true, content: res.data.content }
        : draft
          ? { ok: true, content: draft.content }
          : { ok: false, message: res.error.message }
      // A dead session is global, not local to this preview — the shared handler
      // signs out and navigates, so there is nothing to show here.
      if (!res.ok && handleExpiredSession(res.error)) return
      cache.set(key, result)
      if (!cancelled) setLoaded(result)
    })
    return () => {
      cancelled = true
    }
  }, [key, path, repo.owner, repo.name, repo.branch])

  const kind = fileKind(path)
  const Icon = kind === 'excalidraw' ? ExcalidrawIcon : kind === 'markdown' ? MarkdownIcon : MermaidIcon

  // Placed under the link, flipped above it when there isn't room, and clamped
  // to the viewport horizontally. Fixed positioning, so the numbers are screen
  // coordinates exactly as `getBoundingClientRect` reports them.
  const width = 380
  const maxHeight = 300
  const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - width - 8))
  const below = anchor.bottom + 8
  const flip = below + maxHeight > window.innerHeight && anchor.top > maxHeight
  const top = flip ? Math.max(8, anchor.top - maxHeight - 8) : below

  return (
    <div
      className="pointer-events-none fixed z-50 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
      style={{ left, top, width, maxHeight }}
      role="tooltip"
    >
      <div className="flex items-center gap-1.5 border-b px-3 py-2 text-xs">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono">{path}</span>
      </div>
      <div className="relative max-h-[252px] overflow-hidden px-3 py-2.5">
        {loaded === null ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        ) : !loaded.ok ? (
          <p className="text-xs text-muted-foreground">{loaded.message}</p>
        ) : (
          <PreviewBody content={loaded.content} path={path} config={config} />
        )}
        {/* Fade the cut edge, so a clipped preview reads as "more below" rather
            than as a document that stops mid-sentence. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-popover to-transparent" />
      </div>
    </div>
  )
}

/** The rendered body for each kind of file. */
function PreviewBody({
  content,
  path,
  config,
}: {
  content: string
  path: string
  config: MermaidUserConfig | null
}) {
  const kind = fileKind(path)
  const [parts, setParts] = useState<MarkdownPart[] | null>(null)
  const [svg, setSvg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (kind === 'markdown') {
      const { source } = truncateSource(content)
      void renderMarkdown(source, { config }).then((result) => {
        if (!cancelled) setParts(result.parts)
      })
    } else if (kind === 'mermaid') {
      renderToSvg(content, config).then(
        (result) => {
          if (!cancelled) setSvg(result)
        },
        () => {
          if (!cancelled) setSvg(null)
        },
      )
    }
    return () => {
      cancelled = true
    }
  }, [content, kind, config])

  if (kind === 'excalidraw') {
    return <p className="text-xs text-muted-foreground">{sceneSummary(content)}</p>
  }

  if (kind === 'mermaid') {
    return svg ? (
      // Scaled down to the card rather than zoomable: this is a glance, and the
      // real viewport is one click away.
      <div
        className="preview-svg [&_svg]:max-h-[220px] [&_svg]:w-full"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    ) : (
      <pre className="text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {content.slice(0, 400)}
      </pre>
    )
  }

  return parts === null ? (
    <div className="space-y-2" aria-hidden>
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-full" />
    </div>
  ) : (
    <div className="md-prose md-prose-compact">
      {parts.map((part, i) =>
        part.type === 'diagram' ? (
          <div
            key={i}
            className="md-mermaid preview-svg"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: part.svg }}
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
  )
}
