'use client'

import { toast } from 'sonner'
import { logout } from '@/app/actions/auth'
import type { ActionError } from './types'

/** Module-level, so concurrent failing actions collapse into one sign-out. */
let signingOut = false

/**
 * A dead GitHub session is not a per-surface error — it invalidates the whole
 * signed-in app at once, so it is handled globally rather than rendered wherever
 * the unlucky call happened to originate. Any action can return
 * `kind: 'unauthenticated'` (see `mapError` in `app/actions/github.ts`), and it
 * means exactly one thing: the credentials in the session cookie can no longer be
 * renewed, so every *other* repo action is equally doomed. Showing that as a
 * message inside a dialog or the history panel left the user in an app whose
 * every control was silently broken.
 *
 * Instead: drop the session cookie and land on the marketing page, where signing
 * in again is the primary action. `logout()` (`signOut({ redirectTo: '/' })`) is
 * the same server action the account menu uses, so there is one sign-out path,
 * and clearing the cookie server-side is what actually ends the session — a
 * client-side redirect alone would leave the stale cookie to fail the next call.
 *
 * Nothing is lost: localStorage holds the uncommitted draft and the app config,
 * this navigation stays on the same origin, and the draft is restored when the
 * user signs back in.
 *
 * @returns `true` if the error was a dead session and sign-out is under way — the
 *   caller must return without reporting the error, since the app is leaving.
 *   `false` for every other error kind, which callers surface as before.
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
