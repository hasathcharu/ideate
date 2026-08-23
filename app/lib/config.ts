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

/**
 * URL-safe slug of the GitHub App backing this deployment — the `<slug>` in
 * `https://github.com/apps/<slug>`. Set via `NEXT_PUBLIC_GITHUB_APP_SLUG` (it has
 * to reach the client, since the install links are rendered in the repo picker).
 * Not a secret: it is the App's public name.
 */
export const GITHUB_APP_SLUG = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG || ''

/**
 * Where to send a user to install the App or to change which repositories it can
 * see. GitHub serves both from the same URL: it shows the install screen when the
 * App isn't installed yet and the "repository access" configuration screen when it
 * is. Falls back to the user's global installations list if the slug is unset, so
 * the links still go somewhere useful in a misconfigured deployment.
 */
export const GITHUB_APP_INSTALL_URL = GITHUB_APP_SLUG
  ? `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`
  : 'https://github.com/settings/installations'

/** Short commit hash of the running build, inlined at build time (see
 *  next.config.ts). Falls back to 'dev' outside a git checkout (e.g. some
 *  deploy environments) or in local development. */
export const COMMIT_SHA = process.env.NEXT_PUBLIC_COMMIT_SHA || 'dev'

/**
 * Where Agent Link's service lives by default.
 *
 * `NEXT_PUBLIC_` because the browser is what dials it, and not a secret: it is a
 * public endpoint that issues nothing and holds nothing durable, and pairing with
 * it needs a code only the tab knows. A user can point a single tab somewhere else
 * from the modal's Advanced options (that override lives in `AppConfig.relayOrigin`
 * — a deployment setting shared by the whole origin, unlike the on/off switch);
 * this is the value that field resets to.
 */
export const DEFAULT_RELAY_ORIGIN =
  process.env.NEXT_PUBLIC_RELAY_ORIGIN || 'https://ideate-mcp.haru.lk'
