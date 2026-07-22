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
    /** GitHub OAuth access token. SERVER-SIDE ONLY — never exposed to client. */
    accessToken?: string
    githubLogin?: string
  }
}

/** GitHub's OAuth profile carries a `login`; not typed by the provider. */
declare module 'next-auth' {
  interface Profile {
    login?: string
  }
}
