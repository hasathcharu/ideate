'use server'

import { signIn, signOut } from '@/auth'

export async function loginWithGitHub() {
  // `connect=1` tells the editor this arrival is a fresh sign-in, so it clears
  // any previously selected repository and starts at the picker. AppShell
  // consumes the flag and strips it from the URL, so a later reload (or a
  // shared link) doesn't reset the selection again.
  await signIn('github', { redirectTo: '/editor?connect=1' })
}

export async function logout() {
  await signOut({ redirectTo: '/' })
}
