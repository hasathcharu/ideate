/** The one place GitHub App access tokens get refreshed. */
import type { NextFetchEvent, NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { forwardAuthCookies } from '@/lib/authCookies'

const authProxy = auth((_request, _event: NextFetchEvent) => NextResponse.next())

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  const authResponse = await authProxy(request, event)
  if (!(authResponse instanceof Response)) throw new Error('Auth proxy returned no response')
  const setCookies = authResponse.headers.getSetCookie()
  const response = NextResponse.next({
    request: { headers: forwardAuthCookies(request.headers, setCookies) },
  })
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie)
  return response
}

export const config = {
  /** Everything except Auth.js's own endpoints and static assets. */
  matcher: [
    '/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|json|woff|woff2)$).*)',
  ],
}
