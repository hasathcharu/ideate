/**
 * The one place GitHub App access tokens get refreshed.
 *
 * (This is the file Next.js ≤15 called `middleware.ts`. Next 16 renamed the
 * convention to `proxy.ts` — same request hook, same `config.matcher`, but the
 * old name now logs a deprecation warning on every build. The exported handler
 * must be named `proxy`.)
 *
 * `auth` used directly as the proxy handler decodes the session JWT, runs the
 * `jwt` callback (which refreshes the access token when it is close to expiring —
 * see `auth.ts`), re-encodes the JWT and copies the resulting `Set-Cookie` onto
 * the response. This is the only hook in the request lifecycle where that last
 * step is possible: `cookies().set()` throws during a Server Component render, so
 * a token rotated from `getGitHubToken()` or a page render would be silently
 * dropped — and since GitHub invalidates the old refresh token on every refresh,
 * dropping the new one locks the user out. Hence refresh lives here and
 * `lib/session.server.ts` stays a pure reader.
 *
 * No `authorized` callback is configured, so this NEVER redirects: it is a
 * pass-through that only maintains the cookie. Unauthenticated requests carry no
 * session cookie, so nothing is decoded and no refresh is attempted — local mode
 * (`/editor?mode=local`) and the landing page are unaffected. Route-level access
 * control stays where it already is, in `app/editor/page.tsx`.
 */
export { auth as proxy } from '@/auth'

export const config = {
  /**
   * Everything except Auth.js's own endpoints and static assets.
   *
   * Page navigations to `/editor` are covered, and so are server-action calls —
   * those POST back to the page's own URL, not to `/api/*`, so they match here
   * and get a refreshed cookie on the way out.
   *
   * `/api/auth/*` is excluded: those routes are Auth.js's own (sign-in, callback,
   * session) and manage the cookie themselves; running the session flow twice on
   * them would be redundant at best and could clobber a callback's own
   * `Set-Cookie`.
   */
  matcher: [
    '/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|json|woff|woff2)$).*)',
  ],
}
