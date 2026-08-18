import 'server-only'
import { headers } from 'next/headers'
import { getToken } from 'next-auth/jwt'

/**
 * Read the GitHub access token from the encrypted session JWT — SERVER SIDE
 * ONLY. The token is stored in the JWT (never in the client-visible session),
 * so we decode it here for server actions to construct Octokit.
 *
 * This is a PURE READER by design. Renewing the GitHub App's 8-hour token
 * happens exclusively in `proxy.ts`, because writing a cookie is impossible
 * from here: `cookies().set()` throws during a Server Component render, so a
 * refreshed token obtained at this point would be dropped by Auth.js while
 * GitHub had already invalidated the refresh token that produced it — locking the
 * user out on the next request. Do not add refresh logic to this file.
 *
 * We try both the secure and non-secure cookie names so it works in local dev
 * (http) and in production (https, `__Secure-` prefixed cookie) alike.
 */
export async function getGitHubToken(): Promise<string | null> {
  const secret = process.env.AUTH_SECRET
  if (!secret) return null

  const h = await headers()
  const req = { headers: h } as unknown as Request

  for (const secureCookie of [true, false]) {
    const token = await getToken({ req, secret, secureCookie })
    if (!token) continue

    // A spent or revoked refresh token clears the credentials and stamps
    // `error` (see `auth.ts`). Report that as signed out so callers surface a
    // clean "sign in again" prompt.
    if (token.error) return null

    const accessToken = token.accessToken
    if (typeof accessToken !== 'string' || accessToken.length === 0) continue

    // `proxy.ts` refreshes ~30 minutes ahead of expiry, so an actually-expired
    // token here means it never got the chance (e.g. a request that bypassed the
    // matcher). Don't spend a GitHub call we know would 401.
    if (typeof token.expiresAt === 'number' && token.expiresAt * 1000 <= Date.now()) return null

    return accessToken
  }
  return null
}
