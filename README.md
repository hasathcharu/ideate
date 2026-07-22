# SketchMade

A web-based Mermaid diagram editor where **your own GitHub repository is the
database**. There is no application database. You sign in with GitHub, connect a
repo, edit diagrams in a split-pane editor with a live themed preview, export to
PNG/SVG/PDF, and commit your work straight to the repo. Every diagram's commit
history doubles as its version history.

## Mental model

- **localStorage is the working copy** — your uncommitted, in-progress edits.
- **GitHub is the committed state.**
- The app behaves like git: editing changes the working copy, **Save is a
  commit**, and opening an old version is `git checkout <sha> -- file`.

## Features

- Split-pane **CodeMirror 6** editor with a live [`beautiful-mermaid`](https://www.npmjs.com/package/beautiful-mermaid)
  preview (flowchart, state, sequence, class, ER, XY chart).
- **Theme switching** across `beautiful-mermaid`'s built-in themes plus VS Code /
  Shiki themes — applied live via CSS custom properties (no re-render).
- **Export** to SVG, PNG (high-DPI raster) and PDF (true vector), with the theme
  colors resolved and inlined so downloads are never colorless.
- **GitHub as database**: repo picker, file-tree browser, open, and Save = commit
  directly to `main`.
- **Conflict handling**: if the file moved on GitHub since you loaded it, choose
  *Overwrite* (commit on top of the latest — never a force-push) or *Start over*.
- **Version history**: browse a file's commits, preview any version read-only,
  and either recover it into your working tree or fork it into a new file.

## Tech stack

Next.js (App Router, TypeScript strict) · Auth.js v5 (GitHub OAuth) ·
beautiful-mermaid · CodeMirror 6 · @octokit/rest (server-side only) ·
jsPDF + svg2pdf.js · Shiki.

> This app **cannot** be a static export — authentication and all GitHub I/O run
> in server actions, so it needs a server runtime (Vercel / Cloudflare Pages /
> Netlify functions, etc.).

## Local setup

### 1. Install

```bash
npm install
```

### 2. Register a GitHub OAuth App

Create an OAuth app at **GitHub → Settings → Developer settings → OAuth Apps →
New OAuth App** (<https://github.com/settings/developers>):

| Field | Value (local dev) |
|---|---|
| Application name | `keep-mermaid (dev)` |
| Homepage URL | `http://localhost:3000` |
| Authorization callback URL | `http://localhost:3000/api/auth/callback/github` |

Then generate a client secret. For production, register a second OAuth app (or
add a second callback) using your deployed origin, e.g.
`https://your-app.example.com/api/auth/callback/github`.

**Scopes.** The requested OAuth scope is a single, clearly-commented config point
in [`auth.ts`](./auth.ts):

```ts
export const GITHUB_OAUTH_SCOPE = 'repo' // 'repo' = public + private; 'public_repo' = public only
```

Use `repo` if you need to read/write **private** repositories; `public_repo` if
public repos are enough.

### 3. Configure environment

Copy the example and fill it in (Auth.js v5 auto-detects these names):

```bash
cp .env.example .env.local
```

```bash
# .env.local
AUTH_SECRET=          # generate with: npx auth secret   (or: openssl rand -base64 33)
AUTH_GITHUB_ID=       # OAuth App "Client ID"
AUTH_GITHUB_SECRET=   # OAuth App "Client secret"
# AUTH_URL=http://localhost:3000   # only if not the default dev origin / behind a proxy
```

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>. You land on a start page with two choices:

- **Local mode** — start drawing immediately; edits stay in your browser
  (localStorage). No account needed. Editor, live themed preview and export all
  work offline.
- **GitHub repo mode** — sign in with GitHub, connect a repository, and commit
  diagrams to `main`; every commit is a version.

The whole UI recolors to match the selected diagram theme (built with Tailwind v4
+ shadcn/ui). The file-tree sidebar is collapsible, and exports can be downloaded
or copied to the clipboard (SVG/PNG).

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` (strict) |

## Security model

- The GitHub access token lives **only** inside the encrypted Auth.js session
  JWT and is read **server-side** by server actions. It is never written to
  `localStorage`, never placed on the session object exposed at
  `/api/auth/session`, and never passed to a client component.
- `localStorage` stores only uncommitted drafts and app config (selected repo,
  theme, export preference) — never tokens or secrets.

## Scope / limitations (MVP)

- Six diagram types (whatever `beautiful-mermaid` supports); no core-`mermaid.js`
  fallback yet.
- Commits go to `main` only — no branching, no branch selector.
- Single-file commits (no multi-file atomic commits).
- Version history uses `GET /commits?path=`, which does **not** follow renames —
  history appears to stop at a rename. This is expected.