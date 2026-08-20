# Ideate

A web-based diagram editor where **your own GitHub repository is the database**.
There is no application database. You sign in with GitHub, connect a repo, edit
diagrams, export to PNG/SVG, and commit your work straight to the repo. Every
diagram's commit history doubles as its version history.

Three kinds of document live side by side in the same repo, chosen by file
extension:

- **Mermaid** (`.mmd`, `.mermaid`) — diagram source, in a split-pane editor with
  a live preview.
- **Markdown** (`.md`, `.markdown`) — prose, in the same split-pane editor with a
  rendered preview. Any ` ```mermaid ` fence renders inline as a themed diagram,
  while the file on disk stays plain markdown that GitHub renders too.
- **Excalidraw** (`.excalidraw`) — a hand-drawn-style canvas, using the real
  Excalidraw editor.

Because an `.excalidraw` file is just JSON, all three ride the same git flow:
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
- **Export** to SVG and PNG (high-DPI raster) for diagrams and canvases, with a
  choice of background (white / black / transparent / the theme's own). Downloads
  stand alone: mermaid bakes literal colors into its SVG, and Excalidraw inlines
  the fonts it used. PNG resolution scales with the diagram so small drawings
  still export sharp. Source export too — mermaid with the config baked in as
  frontmatter, or the raw `.excalidraw` scene. Markdown exports as markdown —
  the document verbatim, so what leaves matches what's in the repo.
- **Agent Link** (beta): an MCP server that hands a coding agent the document open in your
  browser — edits land in the editor as undoable changes and come back with the
  renderer's verdict, so a broken diagram is fixed in the same turn. Nothing is ever
  committed; saving stays yours.
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
kind; the **+** buttons (at the root or on any folder) let you start a mermaid
diagram, a markdown document or a canvas. Exports can be downloaded or copied to
the clipboard, and any surface can be expanded to fill the browser window.

## Agent Link (beta) — let a coding agent edit the open document

> **Beta.** The tool surface and the wire protocol between the app and the MCP
> server can still change between versions. The two sides carry a protocol version
> and refuse to talk on a mismatch rather than guessing, so the failure is loud:
> update whichever side is older.

Ideate ships an **MCP server**, so an agent can read and edit the document that is
**open in your browser right now**. Edits arrive in the editor as ordinary undoable
changes, and the agent gets the renderer's verdict back in the result of its own
tool call — so it fixes a broken diagram in the same turn instead of leaving it for
you to find.

**Nothing is ever committed.** Saving stays a human action, so the most an agent can
touch is your uncommitted working copy — on screen, and one ⌘Z away.

### Setting it up

Every MCP client takes a command and its arguments. Add Ideate as an MCP server with:

```
command  npx
args     -y  github:hasathcharu/ideate
```

Most clients read that from a JSON config file:

```json
{
  "mcpServers": {
    "ideate": {
      "command": "npx",
      "args": ["-y", "github:hasathcharu/ideate"]
    }
  }
}
```

Some offer a CLI instead — for example `claude mcp add ideate -- npx -y
github:hasathcharu/ideate`, or the equivalent in your own tool.

From a checkout of this repo, point the client at `npx` with args `tsx
mcp/index.ts` instead, which skips the download entirely.

> **Don't hand an MCP client `npm run mcp`.** `npm run` prints a two-line banner to
> **stdout**, which is the JSON-RPC channel — it corrupts the stream before the
> server says a word. `npm run mcp` is fine for eyeballing the server by hand
> (it logs to stderr); for a client, use `npx tsx mcp/index.ts`, or
> `npm run mcp --silent`.

> The `npx` form installs this repo's whole dependency tree (~1050 packages,
> ~840MB) because the server shares the root `package.json`. It is a one-time,
> cached cost; running it from a checkout avoids it.

Then, in the app, click **Connect Agent** in the toolbar and switch it on. There is
no port and no token to copy — the two sides find each other on the loopback
interface.

Two deliberate steps stand between an agent and your document, and they answer
different questions:

- **Which tab** is yours to answer. The switch is **per tab**, so it arms the tab you
  flip it in and no other — with several Ideate tabs open, you choose which document
  is reachable. The button then reads **Awaiting Agent**.
- **Whether to drive it** is the agent's. It must call `ideate_connect` on its own
  side; until it does, nothing can read or edit. The button reads **Agent Connected**
  once it has, naming the agent that attached.

### Tools

| Tool | Does |
|---|---|
| `ideate_status` | What is open: repo, branch, path, kind, dirty, cursor |
| `ideate_list_files` | Every file in the connected repository |
| `ideate_read` | The open working copy, or another file as committed |
| `ideate_edit` | Anchored string replacements — one undo step, plus diagnostics |
| `ideate_write` | Replace the whole document |
| `ideate_open` | Open a file in the editor |
| `ideate_create_file` | A new uncommitted file, seeded from a template |
| `ideate_check` | Ask the renderer what it thinks, without editing |
| `ideate_scene_get` | List the elements on an Excalidraw canvas |
| `ideate_scene_edit` | Add / move / restyle / remove canvas elements |

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` (strict) over both the app and `mcp/` |
| `npm run mcp` | Run the Agent Link MCP server by hand (clients need `npx tsx mcp/index.ts` — see above) |
| `npm run build:mcp` | Compile the MCP server to `dist-mcp/` (runs on `prepare`) |
| `npm run gen:agent-key` | Generate the Ed25519 key that signs Agent Link tokens |
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

### Agent Link

- **Off by default**, switched on per browser, and the toolbar always shows whether
  an agent is attached — an agent can never be editing invisibly.
- The MCP server listens on **loopback only** (`127.0.0.1`); nothing is reachable
  from your network.
- A WebSocket has no same-origin policy, so any page could otherwise claim that
  socket, answer your agent's commands and feed it poisoned text. Two things stop
  it: an `Origin` allowlist on the handshake (browsers must send it and page script
  cannot forge it), and a **single-use signed token** the tab mints from
  `/api/agent/token`. That route deliberately returns **no CORS headers** — and
  that, rather than the signature, is what means only a real Ideate page can obtain
  a token.
- Tokens are Ed25519, last 60 seconds, and are held in memory only — never in
  `localStorage`. The server pins which issuers it trusts and never fetches a key
  from an issuer it was not told about.
- Any process already running as you on your machine could reach the socket. That
  is accepted rather than defended: such a process can already read your files and
  your browser profile. It is the same footing as the Docker socket.
- **Prompt injection is the larger risk here.** Your agent reads documents from your
  repository, and a `.md` file can contain instructions aimed at it. Agent Link does
  not create that risk, but it does give the agent write access to the open
  document — which is why there is no commit tool.

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
- Agent Link serves **one tab per server**: a second agent session takes the next
  port in its range, and a second tab is refused while one holds the connection.
- Agent Link exposes no commit, rename or delete tool. In this app rename and delete
  *are* commits, so exposing them would break the "an agent cannot write to your
  repository" guarantee.