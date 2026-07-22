import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'

/* ─────────────────────────────────────────────────────────────────────────
 * SINGLE OAUTH SCOPE CONFIG POINT
 *
 *   'repo'        → read/write contents of PUBLIC *and* PRIVATE repositories
 *   'public_repo' → read/write contents of PUBLIC repositories only
 *
 * Change this one constant to control which repositories the app may use as a
 * database. `repo` is the default so private repos work out of the box.
 * ───────────────────────────────────────────────────────────────────────── */
export const GITHUB_OAUTH_SCOPE = 'repo'

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    GitHub({
      authorization: { params: { scope: GITHUB_OAUTH_SCOPE } },
    }),
  ],
  callbacks: {
    /**
     * Runs whenever the JWT is created/updated. We persist the GitHub access
     * token here — into the ENCRYPTED session JWT, server-side only. The browser
     * receives only an opaque encrypted cookie it cannot read.
     */
    async jwt({ token, account, profile }) {
      if (account?.access_token) token.accessToken = account.access_token
      if (profile && typeof profile.login === 'string') token.githubLogin = profile.login
      return token
    },
    /**
     * Shapes the session object. CRITICAL: this object is serialized to the
     * browser via `/api/auth/session`, so the access token must NEVER be added
     * here. Only non-secret display fields are exposed.
     */
    async session({ session, token }) {
      if (token.githubLogin) session.githubLogin = token.githubLogin
      return session
    },
  },
})
