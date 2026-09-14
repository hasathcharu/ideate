/** Product name — shown in the UI, page title and commit messages. */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME

/** The project's GitHub repo — used for "Report an issue" / "Star on GitHub" links. */
export const REPO_URL = 'https://github.com/hasathcharu/ideate'

/**
 * URL-safe slug of the GitHub App backing this deployment — the `<slug>` in
 * `https://github.com/apps/<slug>`.
 */
export const GITHUB_APP_SLUG = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG || ''

/** Where to send a user to install the App or to change which repositories it can see. */
export const GITHUB_APP_INSTALL_URL = GITHUB_APP_SLUG
  ? `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`
  : 'https://github.com/settings/installations'

/** Short commit hash of the running build, inlined at build time (see
 *  next.config.ts). Falls back to 'dev' outside a git checkout (e.g. some
 *  deploy environments) or in local development. */
export const COMMIT_SHA = process.env.NEXT_PUBLIC_COMMIT_SHA || 'dev'

/**
 * Where Agent Link's service lives by default. `NEXT_PUBLIC_` because the browser is what dials it,
 * and not a secret: it is a public endpoint that issues nothing and holds nothing durable, and
 * pairing with it needs a code only the tab knows.
 */
export const DEFAULT_MCP_ORIGIN =
  process.env.NEXT_PUBLIC_MCP_ORIGIN || 'https://ideate-mcp.haru.lk'
