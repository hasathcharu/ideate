import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import AppShell from '@/components/AppShell'
import type { SessionUser } from '@/lib/types'

export default async function EditorPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>
}) {
  const { mode } = await searchParams
  const session = await auth()

  const user: SessionUser | null = session?.user
    ? {
        name: session.user.name ?? null,
        image: session.user.image ?? null,
        login: session.githubLogin ?? null,
      }
    : null

  // Not signed in and not explicitly in local mode → send to the landing page.
  if (!user && mode !== 'local') redirect('/')

  return <AppShell user={user} mode={user ? 'github' : 'local'} />
}
