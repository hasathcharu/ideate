'use client'

import { toast } from 'sonner'
import { logout } from '@/app/actions/auth'
import type { ActionError } from './types'

/** Module-level, so concurrent failing actions collapse into one sign-out. */
let signingOut = false

/**
 * A dead GitHub session is not a per-surface error — it invalidates the whole signed-in app at
 * once, so it is handled globally rather than rendered wherever the unlucky call happened to
 * originate.
 */
export function handleExpiredSession(error: ActionError): boolean {
  if (error.kind !== 'unauthenticated') return false
  // Concurrent actions (a tree refresh alongside a commit, say) all fail the same
  // way, so this is a one-shot: sign out once, toast once.
  if (signingOut) return true
  signingOut = true
  // The Toaster lives in the root layout and `redirectTo` is a client-side
  // navigation, so this message survives the trip and explains the ejection on
  // the page the user lands on.
  toast.error('Your GitHub session expired. Please sign in again.')
  void logout()
  return true
}
