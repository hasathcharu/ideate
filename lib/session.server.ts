import 'server-only'
import { headers } from 'next/headers'
import { getToken } from 'next-auth/jwt'

/**
 * Read the GitHub access token from the encrypted session JWT — SERVER SIDE
 * ONLY. The token is stored in the JWT (never in the client-visible session),
 * so we decode it here for server actions to construct Octokit.
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
    const accessToken = token?.accessToken
    if (typeof accessToken === 'string' && accessToken.length > 0) {
      return accessToken
    }
  }
  return null
}
