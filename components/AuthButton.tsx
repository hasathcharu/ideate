'use client'

import { useState } from 'react'
import { LogOut, MessageSquareWarning, Star } from 'lucide-react'
import { loginWithGitHub, logout } from '@/app/actions/auth'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { GithubIcon } from '@/components/icons'
import { COMMIT_SHA, REPO_URL } from '@/lib/config'
import type { SessionUser } from '@/lib/types'

export interface AuthButtonProps {
  user: SessionUser | null
}

export default function AuthButton({ user }: AuthButtonProps) {
  const [open, setOpen] = useState(false)

  if (!user) {
    return (
      <form action={loginWithGitHub}>
        <Button type="submit" size="sm">
          <GithubIcon /> Sign in
        </Button>
      </form>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent"
        title="Account"
      >
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.image}
            alt=""
            width={22}
            height={22}
            className="rounded-full border border-border"
          />
        ) : null}
        <span className="max-w-35 truncate text-sm text-muted-foreground">
          {user.login ?? user.name ?? 'Signed in'}
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader className="flex-row items-center gap-3">
            {user.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.image}
                alt=""
                width={40}
                height={40}
                className="rounded-full border border-border"
              />
            ) : null}
            <DialogTitle>{user.login ?? user.name ?? 'Account'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Button asChild variant="ghost" className="justify-start">
              <a href={`${REPO_URL}/issues/new`} target="_blank" rel="noreferrer noopener">
                <MessageSquareWarning /> Report an issue
              </a>
            </Button>
            <Button asChild variant="ghost" className="justify-start">
              <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
                <Star /> Star on GitHub
              </a>
            </Button>
            <form action={logout}>
              <Button type="submit" variant="ghost" className="w-full justify-start">
                <LogOut /> Log out
              </Button>
            </form>
          </div>
          <DialogFooter className="items-center justify-between text-xs text-muted-foreground sm:justify-between">
            <span>{COMMIT_SHA}</span>
            <a
              href="https://hasathcharu.com"
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-foreground hover:text-primary hover:underline"
            >
              Made by Hasathcharu
            </a>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
