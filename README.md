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
- **Agent Link**: a remote MCP server that hands a coding agent the document
  open in your browser — you pair the two with a short code, edits land in the editor
  as undoable changes and come back with the renderer's verdict, so a broken diagram
  is fixed in the same turn. Nothing is ever committed; saving stays yours.
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
@octokit/rest (server-side only). Agent Link's service is Go, using the official
MCP Go SDK.

> This app **cannot** be a static export — authentication and all GitHub I/O run
> in server actions, so it needs a server runtime (Vercel / Cloudflare Pages /
> Netlify functions, etc.).

## Repository layout

```
package.json          thin root: scripts that delegate into app/, plus relay:*
app/                  the Next.js app (app/app/ is its router — not a typo)
ideate-relay/          Go: the Agent Link MCP server + tab relay
```

Two programs in two languages. Only one JS package remains, so there are no npm
workspaces — the root delegates with `npm --prefix app`, and the Go service is its
own module.

## Local setup

### 1. Install

```bash
npm install
```

Run it at the repo root. The root `package.json` holds no dependencies — it
delegates into `app/`, where the Next app lives — and its `postinstall` installs the
app for you.

That in turn copies Excalidraw's font files into `app/public/excalidraw-assets/` so
the canvas never fetches them from a CDN at runtime. That directory is gitignored
and regenerated on install and on every build — don't commit or hand-edit it.

The Agent Link service under `ideate-relay/` is a separate Go module and is not built
by `npm install`; you only need it if you are [running the service
yourself](#running-the-service-yourself). It needs Go 1.25+.

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
cp app/.env.example app/.env.local
```

`.env.local` lives in `app/`, not at the repo root — that is Next's working
directory now that the app is a subdirectory (see [Repository layout](#repository-layout)).

```bash
# .env.local
AUTH_SECRET=                   # generate with: npx auth secret   (or: openssl rand -base64 33)
AUTH_GITHUB_ID=                # GitHub App "Client ID"  (NOT the App ID)
AUTH_GITHUB_SECRET=            # GitHub App client secret
NEXT_PUBLIC_GITHUB_APP_SLUG=   # the <slug> in https://github.com/apps/<slug>
NEXT_PUBLIC_RELAY_ORIGIN=      # Agent Link service origin; optional, see below
# AUTH_URL=http://localhost:3000   # only if not the default dev origin / behind a proxy
```

`NEXT_PUBLIC_GITHUB_APP_SLUG` is public (it's the App's URL name) and only builds
the "Install on GitHub" / "Configure repository access" links in the repo picker.

`NEXT_PUBLIC_RELAY_ORIGIN` points browser tabs at an [Agent Link
service](#agent-link--let-a-coding-agent-edit-the-open-document); leave it unset
to use the shared one. It must be `https://…`, or `http://localhost:7391` for a
service you run yourself. Not a secret — the service issues nothing, and pairing with
it needs a code only your tab knows.

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

## Agent Link — let a coding agent edit the open document

> The app and the service carry a **protocol version** and refuse to talk on a
> mismatch rather than guessing, so a version skew is a loud failure rather than a
> silent one: update whichever side is older.

Ideate ships an **MCP server**, so an agent can read and edit the document that is
**open in your browser right now**. Edits arrive in the editor as ordinary undoable
changes, and the agent gets the renderer's verdict back in the result of its own
tool call — so it fixes a broken diagram in the same turn instead of leaving it for
you to find.

**Nothing is ever committed.** Saving stays a human action, so the most an agent can
touch is your uncommitted working copy — on screen, and one ⌘Z away.

> **Agent Link needs the service to be reachable, and so no longer works offline.**
> Everything else in local mode still does. Until v3 the MCP server ran on your own
> machine and listened on loopback, which Safari blocks outright from an `https://`
> page (no loopback exemption for mixed content) and which confined the feature to
> an agent on the same machine as the browser. The service is a single binary you
> can run yourself (`docker run --rm -p 7391:7391 hasathcharu/ideate-agent-relay`)
> — see [`ideate-relay/README.md`](./ideate-relay/README.md).

### Setting it up

Two things, and only the first is a one-time step.

**1. Register the service with your agent.** It is a remote MCP server over
Streamable HTTP, so a URL rather than a command:

```
claude mcp add --transport http ideate https://ideate-mcp.haru.lk/mcp
```

Most clients read the same thing from a JSON config file:

```json
{
  "mcpServers": {
    "ideate": {
      "type": "http",
      "url": "https://ideate-mcp.haru.lk/mcp"
    }
  }
}
```

A client that only speaks stdio can front it with
`npx mcp-remote https://ideate-mcp.haru.lk/mcp`.

**2. Give your agent this tab's pairing code.** In the app, click **Connect Agent**
in the toolbar, switch it on, and a code like `K7QM-4XZP` appears. Hand it to your
agent when you ask for something. Case and the dash are ignored, and the alphabet
omits I, L, O and U so it survives being read aloud.

The code is an argument on every tool rather than a header, which is what makes the
useful thing possible: **naming a different tab's code is how you point the agent at
a different tab**, mid-session, with nothing to reconfigure. Press **Regenerate** to
revoke the current one without switching the feature off.

Two deliberate steps stand between an agent and your document, and they answer
different questions:

- **Which tab** is yours to answer. The switch and the code are **per tab**, so they
  arm the tab you flip it in and no other. The button then reads **Awaiting Agent**.
- **Whether to drive it** is the agent's. It must call `ideate_connect` with your
  code; until it does, nothing can read or edit — except `ideate_status`, which
  answers with metadata only and never content, so an agent can tell you what it
  would be attaching to. The button reads **Agent Connected** once it has, naming the
  agent that attached.

### Running the service yourself

The shared service caps how many tabs it holds at once, and says so when it is full.
Running your own is one container — no configuration, nothing on disk:

```bash
docker run --rm -p 7391:7391 hasathcharu/ideate-agent-relay
```

From a checkout, `npm run relay:dev` (or `npm run relay:docker`) does the same.
Then point the tab at `http://localhost:7391` under **Agent Link → Advanced
options**, and register `http://localhost:7391/mcp` with your agent:

```bash
claude mcp add --transport http ideate-local http://localhost:7391/mcp
```

Every environment variable and the security model are in
[`ideate-relay/README.md`](./ideate-relay/README.md).

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
| `npm run typecheck` | `tsc --noEmit` (strict) over the app |
| `npm --prefix app run test` | The Agent Link frame-fixture guard (vitest) |
| `npm run relay:dev` | Run the Agent Link service locally on `:7391` |
| `npm run relay:test` | `go vet` + `go test` for the service |
| `npm run relay:build` | Compile the service to `ideate-relay/server` |
| `npm run relay:docker` | Build the service's container image |
| `npm --prefix app run vendor:excalidraw` | Copy Excalidraw's fonts into `app/public/` (runs automatically on `postinstall`, `dev` and `build`) |

Everything at the root delegates into `app/` with `npm --prefix app`; there are no
npm workspaces, because only one JS package remains. The Go service is a separate
module under `ideate-relay/`.

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

- **Off by default**, switched on per browser tab, and the toolbar always shows
  whether an agent is attached — an agent can never be editing invisibly.
- **The pairing code is the credential, and it is the only one.** The service issues
  nothing: your tab generates its own code and the service buckets by the code's
  hash. A hostile page can generate a code and pair with itself, which is harmless;
  what it cannot do is guess yours.
- The code is 8 characters of Crockford base32 — 2^40 — which only holds up because
  guesses are rationed: the service applies a per-IP rate limit, and a much tighter
  one to codes that match no tab. **Regenerate** revokes the current code at once.
- **The code is never logged, never in a URL, never in a query string.** The service
  writes at most an 8-character prefix of its hash.
- **TLS is mandatory**, except for a service you run yourself on
  `http://localhost:7391`. Both the app and the service enforce that rule, because
  plaintext anywhere else would put the code — and every document the tab reads — on
  the wire in the clear.
- A WebSocket has no same-origin policy, so the service also checks `Origin` on the
  handshake. That is a **soft** control that stops it being used as free
  infrastructure; it is not what keeps your tab safe, since a local process can forge
  the header and still cannot guess a code.
- **Your document travels through the service** while Agent Link is on, in local mode
  as much as in repo mode. The service holds nothing durable — every record it keeps
  describes a live socket and dies with the process — but if that is not a trade you
  want, run your own: [`ideate-relay/README.md`](./ideate-relay/README.md).
- **Nothing an agent does reaches GitHub.** There is no commit tool, and rename and
  delete are not exposed either, because in this app those *are* commits.
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
- Agent Link's service holds all its state in memory and does not shard, so it is
  one instance with a hard cap on concurrent tabs (`MAX_WS_SESSIONS`). At capacity it
  says so and points you at running your own. A pairing code holds **one tab**: a
  second tab claiming the same code is refused.
- Agent Link needs the service to be reachable, so it does **not** work offline.
  Everything else in local mode does.
- Agent Link exposes no commit, rename or delete tool. In this app rename and delete
  *are* commits, so exposing them would break the "an agent cannot write to your
  repository" guarantee.