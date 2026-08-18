import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'
import type { JWT } from 'next-auth/jwt'

/* ─────────────────────────────────────────────────────────────────────────
 * GitHub **App** authentication (not an OAuth App).
 *
 * A GitHub App is installed per-account with an explicit repository selection
 * ("All repositories" / "Only select repositories", editable at any time), which
 * is why there is no `authorization: { params: { scope } }` here: GitHub Apps
 * IGNORE the OAuth `scope` parameter entirely. What the app may do comes from the
 * App registration's declared permissions (Contents: read & write, Metadata:
 * read) intersected with the repositories the user picked at install time. Adding
 * a scope option back would be pure misinformation — nothing reads it.
 *
 * (The Auth.js GitHub provider still puts its own default `scope=read:user
 * user:email` on the authorize URL. GitHub discards it for App client IDs, so it
 * is inert; the provider's `/user/emails` fallback is already `res.ok`-guarded, so
 * the App needs no account permissions and sign-in works with `GET /user` alone.)
 *
 * User-to-server tokens expire after 8 hours (GitHub only offers an on/off
 * toggle, no configurable lifetime) and are renewed with a refresh token valid
 * for 6 months. We keep expiry ON and refresh below. Session length is capped at
 * our own layer instead (`SESSION_MAX_AGE`), so the 6-month window never
 * matters in practice.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Session lifetime. Auth.js re-issues the JWT (and its cookie) on every request
 * that touches the session, so this is a *rolling* window: ~10 days of
 * inactivity ends the session and the user re-authorizes. Deliberately not an
 * absolute cap.
 */
const SESSION_MAX_AGE = 10 * 24 * 60 * 60

/**
 * Refresh this far ahead of the access token's real expiry, rather than waiting
 * for it to die. Two reasons:
 *
 *  1. `proxy.ts` sets the rotated cookie on the *response*, so the request that
 *     triggered the refresh still carries the old access token downstream to the
 *     server action. Refreshing early guarantees that old token is still valid.
 *  2. Refresh cannot be locked in a stateless app (no DB — see CLAUDE.md), so two
 *     browser tabs can refresh concurrently. Because both only act inside this
 *     window while still holding a working token, a genuine collision needs two
 *     requests to cross the threshold within milliseconds of each other.
 */
const REFRESH_SKEW_SECONDS = 30 * 60

/** Fallback lifetime if GitHub ever omits `expires_in` (documented as 8h). */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 8 * 60 * 60

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'

/** Shape of `POST /login/oauth/access_token` with `grant_type=refresh_token`. */
interface GitHubRefreshResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  refresh_token_expires_in?: number
  error?: string
  error_description?: string
}

/**
 * Give up on this session: drop the (now unusable) credentials and stamp an
 * error. `getGitHubToken()` reads that as "signed out", so every GitHub action
 * returns `kind: 'unauthenticated'` and the UI can offer a clean re-auth instead
 * of a generic failure. No work is lost — the uncommitted draft lives in
 * localStorage.
 */
function requireReauth(token: JWT): JWT {
  delete token.accessToken
  delete token.refreshToken
  delete token.expiresAt
  token.error = 'RefreshTokenError'
  return token
}

/**
 * Exchange the refresh token for a fresh access token.
 *
 * HAZARD: refresh tokens ROTATE. Each successful call mints a new refresh token
 * and invalidates the one just used, so the new one MUST end up in the JWT (and
 * therefore the cookie). That is why this only ever runs where cookies are
 * writable — see the `canWriteCookies` gate below.
 */
async function refreshAccessToken(token: JWT): Promise<JWT> {
  const clientId = process.env.AUTH_GITHUB_ID
  const clientSecret = process.env.AUTH_GITHUB_SECRET
  const refreshToken = token.refreshToken
  if (!clientId || !clientSecret || !refreshToken) return requireReauth(token)

  let payload: GitHubRefreshResponse
  try {
    const response = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      cache: 'no-store',
    })
    // A transient failure (GitHub 5xx / network error) must NOT end the session:
    // the current access token is still good for up to REFRESH_SKEW_SECONDS, so
    // leave the JWT untouched and let a later request try again.
    if (response.status >= 500) return token
    payload = (await response.json()) as GitHubRefreshResponse
  } catch {
    return token
  }

  // GitHub answers a revoked / expired / already-rotated refresh token with HTTP
  // 200 and an `error` field, so the body decides, not the status.
  if (payload.error || !payload.access_token) return requireReauth(token)

  token.accessToken = payload.access_token
  if (payload.refresh_token) token.refreshToken = payload.refresh_token
  token.expiresAt =
    Math.floor(Date.now() / 1000) + (payload.expires_in ?? DEFAULT_TOKEN_LIFETIME_SECONDS)
  delete token.error
  return token
}

/**
 * Lazy (per-request) config, purely so the `jwt` callback can tell whether the
 * response it is contributing to can carry a `Set-Cookie`.
 *
 * next-auth passes `undefined` here when `auth()` is called from a React Server
 * Component render; it passes the actual request from `proxy.ts` and from the
 * `/api/auth/*` route handlers. Cookies cannot be written during render, so a
 * token rotated there would be silently dropped by Auth.js while GitHub had
 * already invalidated the old refresh token — the exact lockout this migration
 * has to avoid. Hence: refresh only when `request` is present.
 */
export const { handlers, signIn, signOut, auth } = NextAuth((request) => {
  const canWriteCookies = request !== undefined

  return {
    providers: [GitHub],
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE },
    callbacks: {
      /**
       * Runs whenever the JWT is created/updated. The GitHub credentials are
       * persisted here — into the ENCRYPTED session JWT, server-side only. The
       * browser receives only an opaque encrypted cookie it cannot read.
       */
      async jwt({ token, account, profile }) {
        if (account?.access_token) {
          // Initial sign-in (or re-authorization).
          token.accessToken = account.access_token
          token.refreshToken = account.refresh_token
          token.expiresAt = account.expires_at
          delete token.error
        }
        if (profile && typeof profile.login === 'string') token.githubLogin = profile.login

        // Nothing to renew: either the App has token expiry disabled (no refresh
        // token, no expiry) or this session already failed a refresh.
        if (!token.refreshToken || typeof token.expiresAt !== 'number') return token

        const dueAt = (token.expiresAt - REFRESH_SKEW_SECONDS) * 1000
        if (Date.now() < dueAt) return token

        // Expiring soon. Only refresh where the rotated token can be persisted;
        // during a render, leave the JWT alone and let middleware handle it on
        // the next request.
        if (!canWriteCookies) return token
        return refreshAccessToken(token)
      },
      /**
       * Shapes the session object. CRITICAL: this object is serialized to the
       * browser via `/api/auth/session`, so neither the access token NOR the
       * refresh token may ever be added here. Only non-secret display fields.
       */
      async session({ session, token }) {
        if (token.githubLogin) session.githubLogin = token.githubLogin
        return session
      },
    },
  }
})
