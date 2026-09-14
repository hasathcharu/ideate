import 'server-only'
import { headers } from 'next/headers'
import { getToken } from 'next-auth/jwt'

/** Read the GitHub access token from the encrypted session JWT — SERVER SIDE ONLY. */
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
