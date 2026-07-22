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
import { APP_NAME } from '@/lib/config'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import Preview from './Preview'

const CONCEPT = `flowchart LR
  W[localStorage<br/>working copy] -->|Save = commit| G[(GitHub repo<br/>on main)]
  G -->|History| V[Every commit<br/>is a version]
`

const FEATURES = [
  { icon: Palette, title: 'Live themed preview', body: 'Recolor the whole app with built-in and VS Code / Shiki themes.' },
  { icon: Download, title: 'Export', body: 'Download or copy as SVG or high-DPI PNG.' },
  { icon: GitCommitHorizontal, title: 'Commit to GitHub', body: 'Save commits straight to main — no separate database.' },
  { icon: History, title: 'Version history', body: 'Preview any past commit and recover or fork it.' },
]

export default function Landing({ signedIn }: { signedIn: boolean }) {
  // Landing uses a fixed light theme so the chrome matches the hero diagram.
  const theme = THEMES['github-light'] ?? null
  useChromeTheme(theme, false)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2 font-semibold">
          <span className="text-lg text-primary">◇</span> {APP_NAME}
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
            <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
              Draw Mermaid diagrams. Commit them to GitHub.
            </h1>
            <p className="mt-4 max-w-md text-muted-foreground">
              A diagram editor with a live themed preview that saves straight to your
              repo — every commit is a version you can revisit.
            </p>
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
              <Button asChild size="lg" variant="secondary">
                <Link href="/editor?mode=local">
                  <Pencil /> Try it locally
                </Link>
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Local mode runs in your browser — no account needed.
            </p>
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
