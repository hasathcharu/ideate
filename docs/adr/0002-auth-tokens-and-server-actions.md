# 0002. Auth: a GitHub App, server actions, and token refresh

**Status** accepted &nbsp;·&nbsp; **Touches** `app/auth.ts, app/proxy.ts, app/lib/session.server.ts, app/app/actions/github.ts, app/lib/sessionExpiry.ts`

The invariants this record justifies are listed in [`CLAUDE.md`](../../CLAUDE.md). This file holds the reasoning behind them — read it before changing any of them, and update it here when a decision actually changes.

---

## Rule 1

**All GitHub API calls go through Next.js Server Actions** in
`app/actions/github.ts` (each `'use server'`). Octokit is server-side only.

## Rule 2

**The GitHub access token — and the refresh token — never reach the browser.**
Both are persisted into the encrypted session JWT in the `jwt` callback
(`auth.ts`); the access token is read server-side via `getGitHubToken()`
(`lib/session.server.ts`). Neither may be added to the object returned by the
`session` callback (that object is serialized to the client at
`/api/auth/session`), stored in localStorage, or passed as a client-component
prop.

## Rule 14

**Token refresh happens in `proxy.ts` and nowhere else.** GitHub App user
tokens expire in 8h and refresh tokens **rotate** (each use invalidates the
previous one), so a refresh whose result isn't written back to the session
cookie locks the user out. `cookies().set()` throws during a render, so
`getGitHubToken()` must stay a pure reader and `auth.ts`'s `jwt` callback only
refreshes when its lazy-config `request` argument is present (proxy / auth
route handlers), never when it is `undefined` (RSC render). Do not add a
refresh path anywhere else, and do not add a DB/KV lock for it — see the Auth
section below for why a lock is not possible here.

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
- **Losing a repo looks like an empty repo.** GitHub answers `404` — never `403` —
  for a repo the token cannot see, so an uninstall (or narrowed access, or a
  rename/delete) is byte-identical to "this ref doesn't exist". `listTree` used to
  swallow every default-branch 404 as an empty tree, which rendered the connected
  repo as an ordinary "no files" sidebar and invited work that every write would
  reject. It now probes `repos.get` in that error path only (`repoAccessLost`) and
  returns `kind: 'repo_unavailable'`, which `refreshTree` answers by opening
  `RepoPicker`. Only a 404 on the probe counts — a 5xx or rate-limit must not eject
  the user from a repo that is still theirs. The probe needs no new permission
  (Metadata: read covers it), and `config.repo` is deliberately *not* cleared: the
  user may be mid-reinstall.
- **Tokens**: 8h access token + rotating 6-month refresh token, refreshed ~30 min
  ahead of expiry (`REFRESH_SKEW_SECONDS`) in `proxy.ts` (rule 12). Session
  `maxAge` is 10 days, *rolling* (re-issued on activity), so the refresh window
  never expires in practice and there is no absolute-expiry machinery.
- **Concurrent refresh is not locked** and cannot be, statelessly (no app
  database — that's the premise of this repo). The proactive skew is the
  mitigation: colliding requests both still hold a valid token. When a race does
  bite, a failed refresh clears the credentials and stamps `token.error`, which
  `getGitHubToken()` reads as signed-out → every action returns
  `kind: 'unauthenticated'` → `handleExpiredSession` signs the user out and
  lands them on `/`. No work is lost; the draft is in localStorage.
- **`NEXT_PUBLIC_GITHUB_APP_SLUG`** (→ `GITHUB_APP_SLUG` /
  `GITHUB_APP_INSTALL_URL` in `lib/config.ts`) builds the install links. It's the
  App's public URL name, not a secret.


## A dead session is handled globally, never per-surface

`kind: 'unauthenticated'` is the one action error that isn't local to the call
that produced it: it means the session cookie's credentials can't be renewed, so
every other repo action is equally dead. Every client site that branches on an
action error therefore calls `handleExpiredSession(error)`
(`lib/sessionExpiry.ts`) **first** and returns if it answers `true` — it drops the
session via the same `logout()` server action the account menu uses and redirects
to `/`. Rendering the message in place instead (what `RepoPicker` used to do) left
the user inside an app whose every control was silently broken.

Two properties it relies on: clearing the cookie has to happen *server-side*, or
the stale cookie survives to fail the next call; and the flag is module-level, so
concurrent failing actions collapse into one sign-out and one toast. That toast
outlives the navigation because the `Toaster` is in the root layout and
`redirectTo` is a client-side nav. Add the guard to any new error site — a missed
one degrades to the old inline message, not a crash.
