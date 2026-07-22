'use client'

import Link from 'next/link'
import { THEMES } from 'beautiful-mermaid'
import {
  ArrowRight,
  Download,
  GitCommitHorizontal,
  History,
  Palette,
  Pencil,
} from 'lucide-react'
import { loginWithGitHub } from '@/app/actions/auth'
import { GithubIcon } from '@/components/icons'
import { useChromeTheme } from '@/lib/hooks'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import Preview from './Preview'

const CONCEPT = `flowchart LR
  W[localStorage<br/>working copy] -->|Save = commit| G[(GitHub repo<br/>on main)]
  G -->|History| V[Every commit<br/>is a version]
`

const FEATURES = [
  { icon: Palette, title: 'Live themed preview', body: '15 built-in themes plus VS Code / Shiki themes — the whole app recolors instantly.' },
  { icon: Download, title: 'Export anywhere', body: 'SVG, high-DPI PNG, and true-vector PDF — copy to clipboard or download.' },
  { icon: GitCommitHorizontal, title: 'Commit to GitHub', body: 'Saving is a commit to main. No app database — your repo is the source of truth.' },
  { icon: History, title: 'Version history', body: 'Browse a file’s commits, preview any version, recover or fork it.' },
]

export default function Landing({ signedIn }: { signedIn: boolean }) {
  // Landing uses a fixed dark theme so the chrome matches the hero diagram.
  const theme = THEMES['tokyo-night'] ?? null
  useChromeTheme(theme, true)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2 font-semibold">
          <span className="text-lg text-primary">◇</span> keep-mermaid
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href={signedIn ? '/editor' : '/editor?mode=local'}>
            Open editor <ArrowRight />
          </Link>
        </Button>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24">
        <section className="grid items-center gap-10 py-12 md:grid-cols-2 md:py-20">
          <div>
            <p className="mb-4 inline-flex rounded-full border px-3 py-1 text-xs text-muted-foreground">
              Mermaid editor · GitHub-as-database
            </p>
            <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
              Your GitHub repo is the database.
            </h1>
            <p className="mt-4 max-w-md text-muted-foreground">
              Edit Mermaid diagrams with a live themed preview, export to SVG/PNG/PDF, and
              commit straight to your repo. Every commit doubles as version history.
            </p>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Pencil className="size-4" /> Local mode
                  </CardTitle>
                  <CardDescription>
                    Start drawing instantly. Edits live in your browser — no account needed.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button asChild variant="secondary" className="w-full">
                    <Link href="/editor?mode=local">Start drawing</Link>
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <GithubIcon className="size-4" /> GitHub repo mode
                  </CardTitle>
                  <CardDescription>
                    Use a repository as your database. Commit to <code>main</code>; every
                    commit is a version.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {signedIn ? (
                    <Button asChild className="w-full">
                      <Link href="/editor">Open editor</Link>
                    </Button>
                  ) : (
                    <form action={loginWithGitHub}>
                      <Button type="submit" className="w-full">
                        <GithubIcon /> Sign in with GitHub
                      </Button>
                    </form>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-2 shadow-2xl">
            <div className="h-[320px] overflow-hidden rounded-lg">
              <Preview text={CONCEPT} colors={theme} />
            </div>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <Card key={f.title}>
              <CardHeader>
                <f.icon className="size-5 text-primary" />
                <CardTitle className="mt-2 text-base">{f.title}</CardTitle>
                <CardDescription>{f.body}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </section>
      </main>
    </div>
  )
}
