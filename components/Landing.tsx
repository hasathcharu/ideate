'use client'

import Link from 'next/link'
import { ArrowRight, Pencil, TriangleAlert } from 'lucide-react'
import { loginWithGitHub } from '@/app/actions/auth'
import {
  ExcalidrawIcon,
  GithubIcon,
  MarkdownIcon,
  MermaidIcon,
} from '@/components/icons'
import { APP_NAME } from '@/lib/config'
import { Button } from '@/components/ui/button'

/**
 * The three document kinds, in the order the editor's own toggle lists them.
 * Each carries its project's own mark (see `components/icons.tsx`) — bare glyphs
 * in `currentColor`, so the row reads as one family under the active theme.
 */
const KINDS = [
  { icon: MermaidIcon, label: 'Mermaid', ext: '.mmd' },
  { icon: MarkdownIcon, label: 'Markdown', ext: '.md' },
  { icon: ExcalidrawIcon, label: 'Excalidraw', ext: '.excalidraw' },
]

export default function Landing({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-700 md:hidden dark:text-amber-400">
        <TriangleAlert className="size-3.5 shrink-0" />
        {APP_NAME}&nbsp;isn&apos;t built for phone-sized screens — try a larger one for the full
        editor experience.
      </div>
      <header className="mx-auto flex w-full max-w-3xl items-end gap-2 px-6 py-5">
        <span className="text-xl font-bold leading-none">{APP_NAME}</span>
        <span className="text-sm leading-none text-muted-foreground mb-px">
          by{' '}
          <a
            href="https://hasathcharu.com"
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-foreground hover:text-primary hover:underline"
          >
            Hasathcharu
          </a>
        </span>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-6 pb-24 text-center">
        <h1 className="text-4xl leading-tight font-bold tracking-tight md:text-5xl">
          Diagrams, docs and sketches. Committed to GitHub.
        </h1>
        <p className="mt-4 max-w-md text-muted-foreground">
          Mermaid diagrams, Markdown documents and Excalidraw canvases — edited
          with a live preview and saved straight to your repo, where every commit
          is a version you can revisit.
        </p>
        <ul className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {KINDS.map(({ icon: Icon, label, ext }) => (
            <li
              key={ext}
              className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm text-card-foreground"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              {label}
              <span className="font-mono text-xs text-muted-foreground">{ext}</span>
            </li>
          ))}
        </ul>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          {signedIn ? (
            <Button asChild size="lg">
              <Link href="/editor">
                Open editor <ArrowRight />
              </Link>
            </Button>
          ) : (
            <form action={loginWithGitHub}>
              <Button type="submit" size="lg">
                <GithubIcon /> Sign in with GitHub
              </Button>
            </form>
          )}
          {signedIn ? null : (
            <Button asChild size="lg" variant="secondary">
              <Link href="/editor?mode=local">
                <Pencil /> Try it locally
              </Link>
            </Button>
          )}
        </div>
        {signedIn ? null : (
          <p className="mt-3 text-xs text-muted-foreground">
            Local mode runs in your browser — no account needed.
          </p>
        )}
      </main>
    </div>
  )
}
