import 'next-auth'
import 'next-auth/jwt'

declare module 'next-auth' {
  interface Session {
    /** GitHub login (username). Safe to expose to the client. */
    githubLogin?: string
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    /**
     * GitHub App user-to-server access token (8h lifetime).
     * SERVER-SIDE ONLY — never exposed to the client.
     */
    accessToken?: string
    /**
     * GitHub App refresh token (6-month lifetime, rotated on every use).
     * SERVER-SIDE ONLY — as secret as the access token, and subject to the same
     * rule: never put it on the object returned by the `session` callback.
     */
    refreshToken?: string
    /** Unix seconds at which `accessToken` expires; absent if expiry is off. */
    expiresAt?: number
    /**
     * Set when the refresh token is spent/revoked and the session can no longer
     * be renewed. The credentials are cleared alongside it, so the user is
     * treated as signed out and prompted to re-authorize.
     */
    error?: 'RefreshTokenError'
    githubLogin?: string
  }
}

/** GitHub's OAuth profile carries a `login`; not typed by the provider. */
declare module 'next-auth' {
  interface Profile {
    login?: string
  }
}
