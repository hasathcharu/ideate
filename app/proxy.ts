/** The one place GitHub App access tokens get refreshed. */
export { auth as proxy } from '@/auth'

export const config = {
  /** Everything except Auth.js's own endpoints and static assets. */
  matcher: [
    '/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|json|woff|woff2)$).*)',
  ],
}
