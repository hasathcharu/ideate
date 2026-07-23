'use client'

import Link from 'next/link'
import { ArrowRight, Pencil } from 'lucide-react'
import { loginWithGitHub } from '@/app/actions/auth'
import { GithubIcon } from '@/components/icons'
import { APP_NAME } from '@/lib/config'
import { Button } from '@/components/ui/button'

export default function Landing({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-3xl items-end gap-2 px-6 py-5">
        <span className="text-xl font-bold leading-none">{APP_NAME}</span>
        <span className="text-sm leading-none text-muted-foreground mb-0.5">
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
        <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
          Draw Mermaid diagrams. Commit them to GitHub.
        </h1>
        <p className="mt-4 max-w-md text-muted-foreground">
          A diagram editor with a live preview that saves straight to your
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
