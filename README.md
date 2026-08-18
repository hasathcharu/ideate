# Ideate

A web-based diagram editor where **your own GitHub repository is the database**.
There is no application database. You sign in with GitHub, connect a repo, edit
diagrams, export to PNG/SVG, and commit your work straight to the repo. Every
diagram's commit history doubles as its version history.

Two kinds of diagram live side by side in the same repo, chosen by file extension:

- **Mermaid** (`.md`, `.mmd`, `.mermaid`) — text, in a split-pane editor with a
  live preview.
- **Excalidraw** (`.excalidraw`) — a hand-drawn-style canvas, using the real
  Excalidraw editor.

Because an `.excalidraw` file is just JSON, both kinds ride the same git flow:
open, commit, rename, delete, branch, diff, version history.

## Mental model

- **localStorage is the working copy** — your uncommitted, in-progress edits.
- **GitHub is the committed state.**
- The app behaves like git: editing changes the working copy, **Save is a
  commit**, and opening an old version is `git checkout <sha> -- file`.

## Features

- Split-pane **CodeMirror 6** editor with a live [`mermaid`](https://mermaid.js.org/)
  preview supporting every diagram type mermaid renders.
- Full **[Excalidraw](https://excalidraw.com/) canvas** for `.excalidraw` files —
  the actual upstream editor, not a reimplementation, so shapes, arrow binding,
  freedraw, libraries, undo/redo and keyboard shortcuts all behave as they do on
  excalidraw.com. Scenes you create here open there and vice versa. Its bundle is
  code-split, so opening only mermaid diagrams never downloads it, and its fonts
  are served from this app rather than a CDN.
- **Theming & layout**: ~19 built-in color presets (or hand-edit the global
  mermaid YAML config) retune every diagram *and* recolor the whole app chrome
  to match; switch the layout engine between Dagre and ELK. The canvas follows the
  same palette — background, editor chrome, and light/dark mode all derived from
  the active theme, so it doesn't look like an embedded third-party widget.
- **Export** to SVG and PNG (high-DPI raster) for both kinds, with a choice of
  background (white / black / transparent / the theme's own). Downloads stand
  alone: mermaid bakes literal colors into its SVG, and Excalidraw inlines the
  fonts it used. PNG resolution scales with the diagram so small drawings still
  export sharp. Source export too — mermaid with the config baked in as
  frontmatter, or the raw `.excalidraw` scene.
- **GitHub as database**: repo picker, file-tree browser, open, and Save = commit
  to whichever branch is selected. Access is scoped by a **GitHub App
  installation** — the picker lists only the repositories you chose to share, and
  that selection is editable on GitHub at any time.
- **Branches**: switch or create a branch from the branch picker, and open a
  pull request back to the default branch with one click (redirects to GitHub —
  no PR-creation API surface).
- **Conflict handling**: if the file moved on GitHub since you loaded it, choose
  *Overwrite* (commit on top of the latest — never a force-push) or *Start over*.
- **Version history**: browse a file's commits, preview any version read-only,
  and either recover it into your working tree or fork it into a new file.

## Tech stack

Next.js (App Router, TypeScript strict) · Auth.js v5 (GitHub **App**
user-to-server auth) · mermaid · @excalidraw/excalidraw · CodeMirror 6 ·
@octokit/rest (server-side only).

> This app **cannot** be a static export — authentication and all GitHub I/O run
> in server actions, so it needs a server runtime (Vercel / Cloudflare Pages /
> Netlify functions, etc.).

## Local setup

### 1. Install

```bash
npm install
```

`postinstall` copies Excalidraw's font files into `public/excalidraw-assets/` so
the canvas never fetches them from a CDN at runtime. That directory is gitignored
and regenerated on install and on every build — don't commit or hand-edit it.

### 2. Register the GitHub App

This app authenticates with a **GitHub App**, not an OAuth App. That is a
deliberate choice: an OAuth App's `repo` scope is all-or-nothing — authorizing it
hands over every repository you can reach. A GitHub App is *installed* with an
explicit repository selection ("All repositories" or "Only select repositories")
that you can change at any time afterwards, so you can share exactly one repo
with the editor and nothing else.

Create it at **GitHub → Settings → Developer settings → GitHub Apps → New GitHub
App** (<https://github.com/settings/apps/new>):

| Field | Value (local dev) |
|---|---|
| GitHub App name | `Ideate (dev)` — must be globally unique; its slug is the `<slug>` in `https://github.com/apps/<slug>` |
| Homepage URL | `http://localhost:3000` |
| Callback URL | `http://localhost:3000/api/auth/callback/github` |
| Request user authorization (OAuth) during installation | **✅ checked** |
| Expire user authorization tokens | **✅ checked** (leave on — see below) |
| Webhook → Active | **☐ unchecked** (this app has no webhook) |
| Where can this GitHub App be installed? | **Any account** if others should be able to install it; *Only on this account* for a private deployment |

Then set **Permissions → Repository permissions**:

| Permission | Access | Why |
|---|---|---|
| **Contents** | **Read & write** | reading and committing diagram files, listing branches, creating branches |
| **Metadata** | **Read** (mandatory, auto-selected) | repository metadata; GitHub requires it |

Nothing else. In particular there is **no `Pull requests` permission**: "Open PR"
is a plain redirect to GitHub's compare page, so the app never calls a PR API.

Finally, on the App's settings page:

1. Note the **Client ID** (starts with `Iv…`/`Iv23…`) — *not* the App ID.
2. **Generate a new client secret** and copy it.
3. Optionally **Install** the App on your own account to try it right away.
   (Users can also install it from inside the app — the repo picker links to
   `https://github.com/apps/<slug>/installations/new` when nothing is shared yet.)

For production, either add the deployed callback URL to the same App or register a
second App for that origin, e.g.
`https://your-app.example.com/api/auth/callback/github`.

> **Two things to know about the toggles above**
>
> - *"Request user authorization (OAuth) during installation"* collapses install +
>   authorize into a single hop. Without it, a user installs the App but never
>   gets a user token, and the app can't act on their behalf.
> - *"Expire user authorization tokens"* is intentionally left **on**. GitHub
>   offers no configurable lifetime — it's a binary toggle — so user tokens live 8
>   hours and are renewed with a refresh token (valid 6 months, rotated on every
>   use). The app implements that refresh in [`proxy.ts`](./proxy.ts) and caps
>   session length separately at 10 idle days, so tokens on the wire stay
>   short-lived. Turning expiry off to get permanent tokens is a downgrade, not a
>   simplification.
>
> **Migrating from the old OAuth App?** Existing sessions are not portable: every
> signed-in user is signed out once and has to authorize the GitHub App and
> install it on the repositories they want. Uncommitted drafts live in
> localStorage and survive. The old OAuth App can then be deleted.

### 3. Configure environment

Copy the example and fill it in (Auth.js v5 auto-detects these names):

```bash
cp .env.example .env.local
```

```bash
# .env.local
AUTH_SECRET=                   # generate with: npx auth secret   (or: openssl rand -base64 33)
AUTH_GITHUB_ID=                # GitHub App "Client ID"  (NOT the App ID)
AUTH_GITHUB_SECRET=            # GitHub App client secret
NEXT_PUBLIC_GITHUB_APP_SLUG=   # the <slug> in https://github.com/apps/<slug>
# AUTH_URL=http://localhost:3000   # only if not the default dev origin / behind a proxy
```

`NEXT_PUBLIC_GITHUB_APP_SLUG` is public (it's the App's URL name) and only builds
the "Install on GitHub" / "Configure repository access" links in the repo picker.

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>. You land on a start page with two choices:

- **Local mode** — start drawing immediately; edits stay in your browser
  (localStorage). No account needed. Editor, canvas, live themed preview and
  export all work offline. A Diagram/Canvas toggle switches between the two
  surfaces, and each keeps its own draft, so flipping between them never
  overwrites your work.
- **GitHub repo mode** — sign in with GitHub, install the App on the
  repositories you want to share (the repo picker links you there if you haven't
  yet), connect one, pick or create a branch, and commit diagrams there; every
  commit is a version.

The whole UI recolors to match the selected diagram theme (built with Tailwind v4
+ shadcn/ui). The file-tree sidebar is collapsible and marks each file with its
kind; the **+** buttons (at the root or on any folder) let you start either a
mermaid diagram or a canvas. Exports can be downloaded or copied to the clipboard
(SVG/PNG), and either surface can be expanded to fill the browser window.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run vendor:excalidraw` | Copy Excalidraw's fonts into `public/` (runs automatically on `postinstall`, `dev` and `build`) |

## Security model

- The GitHub access token **and its refresh token** live **only** inside the
  encrypted Auth.js session JWT and are read **server-side** by server actions.
  Neither is ever written to `localStorage`, placed on the session object exposed
  at `/api/auth/session`, or passed to a client component.
- `localStorage` stores only uncommitted drafts and app config (selected repo,
  theme, export preference, which scratch surface was last open) — never tokens or
  secrets.
- Repository reach is bounded twice over: by the App's declared permissions
  (Contents, Metadata only) and by the repositories the user selected when
  installing it. Revoking access is a GitHub-side action the user controls.
- Access tokens expire after 8 hours and are refreshed in [`proxy.ts`](./proxy.ts)
  — the only request hook where the rotated token can be written back to the
  session cookie. `lib/session.server.ts` deliberately stays a pure reader:
  `cookies().set()` throws during a render, so a token rotated there would be
  dropped while GitHub had already invalidated the old one.

## Scope / limitations (MVP)

- "Open PR" is a redirect to GitHub's compare page — no PR-creation API call,
  no in-app merge/review flow.
- Single-file commits (no multi-file atomic commits).
- Version history uses `GET /commits?path=`, which does **not** follow renames —
  history appears to stop at a rename. This is expected.
- No mermaid → Excalidraw conversion. It's possible in principle
  (`@excalidraw/mermaid-to-excalidraw`), but the conversion is one-way and not
  deterministic — element IDs and roughjs seeds are random per run — so re-running
  it would produce a spurious diff every time against a repo-as-database.
- A canvas's background is theme-driven chrome and is deliberately **not** saved
  into the scene file, so a `.excalidraw` file's own background is preserved as
  written but not editable from inside this app.