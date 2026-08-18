# CLAUDE.md

Guidance for working in this repository.

## What this is

A Mermaid diagram editor that uses **the user's GitHub repo as the database** —
there is no app database. localStorage holds the uncommitted working copy;
GitHub holds the committed state, on whichever branch is currently selected.
Save = commit; open old version = checkout.

## Hard architectural rules (non-negotiable)

1. **All GitHub API calls go through Next.js Server Actions** in
   `app/actions/github.ts` (each `'use server'`). Octokit is server-side only.
2. **The GitHub access token — and the refresh token — never reach the browser.**
   Both are persisted into the encrypted session JWT in the `jwt` callback
   (`auth.ts`); the access token is read server-side via `getGitHubToken()`
   (`lib/session.server.ts`). Neither may be added to the object returned by the
   `session` callback (that object is serialized to the client at
   `/api/auth/session`), stored in localStorage, or passed as a client-component
   prop.
3. **localStorage stores only** uncommitted editor drafts and app config
   (selected repo, active theme, export prefs). Never tokens/secrets.
4. **Every read/write server action takes a caller-supplied `branch`** — there
   is no fixed branch constant. The selected `{owner, name, defaultBranch,
   branch}` (`RepoRef`, `lib/types.ts`) lives in `AppConfig.repo`;
   `BranchPicker.tsx` lists/creates branches (`listBranches`/`createBranch` in
   `app/actions/github.ts`). "Open PR" is a plain redirect to GitHub's compare
   URL (`compare/{defaultBranch}...{branch}`) — there is no PR-creation API
   surface, and no server-side PR/merge logic of any kind.
5. **The editor and preview are client components** (`'use client'`). Do not SSR
   them.
6. **Never expose a true force-push.** "Overwrite" on conflict = refetch the
   latest sha, then commit on top of it (`onOverwrite` in `AppShell.tsx`). Do not
   use the git data API to rewrite refs.
7. **Diagrams render with the official `mermaid` library** (`lib/mermaid.ts`),
   on the built-in `base` theme so the global YAML config's `themeVariables` can
   retune it. Rendering is async and browser-only. Any diagram type mermaid
   supports works.
8. **Token refresh happens in `proxy.ts` and nowhere else.** GitHub App user
   tokens expire in 8h and refresh tokens **rotate** (each use invalidates the
   previous one), so a refresh whose result isn't written back to the session
   cookie locks the user out. `cookies().set()` throws during a render, so
   `getGitHubToken()` must stay a pure reader and `auth.ts`'s `jwt` callback only
   refreshes when its lazy-config `request` argument is present (proxy / auth
   route handlers), never when it is `undefined` (RSC render). Do not add a
   refresh path anywhere else, and do not add a DB/KV lock for it — see "Auth".

## UI stack

Tailwind CSS v4 + shadcn/ui (Radix, `components/ui/*`) + lucide-react. `cn()` is in
`lib/utils.ts`. Global tokens + `@theme inline` mapping live in `app/globals.css`.
Prefer shadcn primitives and Tailwind utilities over bespoke CSS.

## Routing / modes

- `/` — marketing landing (`components/Landing.tsx`). Unauthenticated users start
  here and pick **Local mode** (`/editor?mode=local`) or **GitHub repo mode**
  (sign in → `/editor`).
- `/editor` — the app (`app/editor/page.tsx` → `AppShell`). Reads `auth()`:
  signed-in → `mode="github"` (repo features on); `?mode=local` without a session
  → `mode="local"` (editor + export only); otherwise redirects to `/`.

## Auth

A **GitHub App** (not an OAuth App), so users choose which repositories the app
may touch at install time and can change that later. Consequences to keep in mind:

- **There is no OAuth scope.** GitHub Apps ignore the `scope` authorization
  param; permission comes from the App registration (Contents: read & write,
  Metadata: read) intersected with the installed repositories. The old
  `GITHUB_OAUTH_SCOPE` constant is **gone** — don't reintroduce a scope option.
- **Authorization ≠ installation.** A signed-in user may have the App installed
  nowhere, so `listRepos()` returns `{ repos, installationCount }` and
  `RepoPicker.tsx` shows an install/"Configure repository access" onboarding state
  when `installationCount === 0`. Repos come from `GET /user/installations` +
  `GET /user/installations/{id}/repositories`, **not** `GET /user/repos` — the
  latter lists repos the App has no permission on.
- **Tokens**: 8h access token + rotating 6-month refresh token, refreshed ~30 min
  ahead of expiry (`REFRESH_SKEW_SECONDS`) in `proxy.ts` (rule 8). Session
  `maxAge` is 10 days, *rolling* (re-issued on activity), so the refresh window
  never expires in practice and there is no absolute-expiry machinery.
- **Concurrent refresh is not locked** and cannot be, statelessly (no app
  database — that's the premise of this repo). The proactive skew is the
  mitigation: colliding requests both still hold a valid token. When a race does
  bite, a failed refresh clears the credentials and stamps `token.error`, which
  `getGitHubToken()` reads as signed-out → every action returns
  `kind: 'unauthenticated'` → the UI offers a clean re-auth. No work is lost;
  the draft is in localStorage.
- **`NEXT_PUBLIC_GITHUB_APP_SLUG`** (→ `GITHUB_APP_SLUG` /
  `GITHUB_APP_INSTALL_URL` in `lib/config.ts`) builds the install links. It's the
  App's public URL name, not a secret.

## Layout

```
auth.ts                     NextAuth v5 config (GitHub App); lazy per-request
                            config + the token-refresh implementation
proxy.ts                    Next 16 request hook (the old `middleware.ts`
                            convention); `export { auth as proxy }` — the ONLY
                            place the refreshed token is written to the cookie.
                            Never redirects; local mode passes straight through
app/
  layout.tsx                fonts + TooltipProvider + <Toaster/> (sonner)
  page.tsx                  landing; editor/page.tsx gates on auth + mode
  globals.css               shadcn tokens, @theme inline, minimal custom CSS
  api/auth/[...nextauth]/    Auth.js route handlers
  actions/{auth,github}.ts  server actions (github.ts = ALL GitHub I/O)
components/
  ui/                       shadcn components
  AppShell.tsx              orchestrator; collapsible sidebar; controlled modals
  Editor, Preview, Landing, ExportMenu, RepoPicker, BranchPicker, FileTree,
  ConflictModal, ConfigModal, DeleteModal, PromptModal, HistoryPanel,
  AuthButton, icons.tsx
lib/
  session.server.ts         server-only token reader (import 'server-only');
                            PURE reader — no refresh, no cookie writes
  mermaid.ts                official-mermaid init + async render (renderToSvg / renderPreview)
  mermaidConfig.ts          global YAML config: parse, layout/theme YAML editing, applyThemeToSite
  themes.ts                 preset theme palettes (THEME_PRESETS) for the theme dropdown
  export.ts                 standalone SVG + SVG/PNG download & copy
  config.ts                 app name / repo URL / commit sha / GitHub App slug
  tree.ts, storage.ts, hooks.ts, types.ts
```

## Rendering & theming

Diagrams render through the official `mermaid` library, initialized once in
`lib/mermaid.ts` on the `base` theme (the only built-in theme that honors
`themeVariables`), `htmlLabels: false` (pure-SVG labels, no `<foreignObject>`),
and `curve: 'basis'` for smooth edges. `mermaid.render()` is async and needs the
DOM, so `Preview.tsx` renders in an effect (guarding against stale in-flight
renders) — never during SSR.

A single global mermaid config, stored as raw YAML text in `AppConfig.mermaidConfig`
(`lib/types.ts`), is the single source of truth for `theme`/`themeVariables`,
`layout`, and any other per-diagram mermaid settings.
It's edited directly via `ConfigModal.tsx` (the settings cogwheel), or indirectly
via the Theme and Layout dropdowns in `AppShell.tsx`, which write into that same
YAML through `setThemeInYaml`/`setLayoutInYaml` (`lib/mermaidConfig.ts`) rather
than owning separate state. `lib/themes.ts` ships ~19 built-in presets
(`THEME_PRESETS`); picking one, or hand-editing `themeVariables`, both retunes
every diagram render **and** recolors the app chrome, via `applyThemeToSite`
mapping the diagram palette onto the shadcn CSS custom properties on `<body>`.
`app/globals.css`'s `:root`/`.dark` blocks are only the fallback palette used
when no theme is set — they are not fixed/static in practice.

## Export

mermaid bakes literal colors and a self-contained `<style>` block into the SVG at
render time, so the markup already stands alone — `lib/export.ts` only normalizes
dimensions (mermaid emits `width="100%"` + a viewBox), adds XML namespaces, and
optionally paints a background (white/black/the active theme's own background
color). Both exporters (SVG / PNG) share the single `resolveStandaloneSvg` step;
PNG rasterizes it via `Image` → `<canvas>`. Exporting the mermaid source
(`exportSource`/`copySource`) bakes the global YAML config in as a real
frontmatter block via `buildExportSource`, so the `.mmd` file stands alone too.

## Conventions

- TypeScript strict; server actions return `ActionResult<T>` so the client can
  branch on errors (especially `kind: 'conflict'` for 409/422, and
  `kind: 'unauthenticated'` for 401 / a dead session) without try/catch.
- Keep server-only code out of client bundles; `lib/session.server.ts` imports
  `server-only` as a guard.

## Verify

```bash
npm run typecheck && npm run build
```

Live GitHub read/write flows require a registered GitHub App and a signed-in user
(see README). Most read-action Octokit shapes were validated against the real
GitHub API during development; the two installation endpoints used by
`listRepos()` and the refresh-token exchange in `auth.ts` were written from the
REST docs and are **not yet verified against live GitHub**.
