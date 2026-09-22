import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'
import type { JWT } from 'next-auth/jwt'

/** GitHub App authentication; permissions come from installations, not OAuth scopes. */

/**
 * Session lifetime. Auth.js re-issues the JWT (and its cookie) on every request that touches the
 * session, so this is a *rolling* window: ~10 days of inactivity ends the session and the user
 * re-authorizes.
 */
const SESSION_MAX_AGE = 10 * 24 * 60 * 60

/** Refresh this far ahead of the access token's real expiry, rather than waiting for it to die. */
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

/** Give up on this session: drop the (now unusable) credentials and stamp an error. */
function requireReauth(token: JWT): JWT {
  delete token.accessToken
  delete token.refreshToken
  delete token.expiresAt
  token.error = 'RefreshTokenError'
  return token
}

/** Exchange the refresh token for a fresh access token. */
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
 * Lazy (per-request) config, purely so the `jwt` callback can tell whether the response it is
 * contributing to can carry a `Set-Cookie`.
 */
export const { handlers, signIn, signOut, auth } = NextAuth((request) => {
  const canWriteCookies = request !== undefined

  return {
    providers: [GitHub],
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE },
    callbacks: {
      /**
       * Runs whenever the JWT is created/updated. The GitHub credentials are persisted here — into
       * the ENCRYPTED session JWT, server-side only.
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
       * Shapes the session object. CRITICAL: this object is serialized to the browser via
       * `/api/auth/session`, so neither the access token NOR the refresh token may ever be added
       * here.
       */
      async session({ session, token }) {
        if (token.githubLogin) session.githubLogin = token.githubLogin
        return session
      },
    },
  }
})
