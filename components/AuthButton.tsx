'use client'

import { LogOut } from 'lucide-react'
import { loginWithGitHub, logout } from '@/app/actions/auth'
import { Button } from '@/components/ui/button'
import { GithubIcon } from '@/components/icons'
import type { SessionUser } from '@/lib/types'

export interface AuthButtonProps {
  user: SessionUser | null
}

export default function AuthButton({ user }: AuthButtonProps) {
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
    <div className="flex items-center gap-2">
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
      <span className="max-w-[140px] truncate text-sm text-muted-foreground">
        {user.login ?? user.name ?? 'Signed in'}
      </span>
      <form action={logout}>
        <Button type="submit" size="icon-sm" variant="ghost" title="Sign out">
          <LogOut />
        </Button>
      </form>
    </div>
  )
}
