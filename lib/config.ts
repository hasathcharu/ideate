/**
 * Product name — shown in the UI, page title and commit messages.
 *
 * Configurable via the `NEXT_PUBLIC_APP_NAME` environment variable (inlined at
 * build time, so it's available in both server and client code). Set it in
 * `.env.local`
 */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME

/** The project's GitHub repo — used for "Report an issue" / "Star on GitHub" links. */
export const REPO_URL = 'https://github.com/hasathcharu/ideate'

/** Short commit hash of the running build, inlined at build time (see
 *  next.config.ts). Falls back to 'dev' outside a git checkout (e.g. some
 *  deploy environments) or in local development. */
export const COMMIT_SHA = process.env.NEXT_PUBLIC_COMMIT_SHA || 'dev'
