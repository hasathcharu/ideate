'use server'

import { signIn, signOut } from '@/auth'

export async function loginWithGitHub() {
  await signIn('github', { redirectTo: '/editor' })
}

export async function logout() {
  await signOut({ redirectTo: '/' })
}
