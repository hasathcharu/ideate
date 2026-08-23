# CLAUDE.md

Guidance for working in this repository.

## What this is

A diagram editor that uses **the user's GitHub repo as the database** — there is
no app database. localStorage holds the uncommitted working copy; GitHub holds the
committed state, on whichever branch is currently selected. Save = commit; open
old version = checkout.

Three kinds of document, decided purely by file extension (`fileKind` in
`lib/tree.ts`):

- **Mermaid** (`.mmd` / `.mermaid`) — pure diagram source, edited in CodeMirror
  beside a live rendered diagram.
- **Markdown** (`.md` / `.markdown`) — a prose document, edited in CodeMirror
  beside rendered HTML, rendered the way GitHub renders it: GFM extras, raw
  (sanitized) HTML, syntax-highlighted fences, in-repo links. Any ```mermaid
  fence inside it renders as a themed diagram (`lib/markdown.ts`).
- **Excalidraw** (`.excalidraw`) — a JSON scene, edited on a full-bleed canvas.

`.md` is **markdown, not mermaid**. A `.md` file holding bare mermaid source
(how this app treated the extension before markdown support) now renders as a
paragraph of text — wrap it in a ```mermaid fence or rename it to `.mmd`.

All three are plain text on disk, which is why they share *every* GitHub path
(read/commit/rename/delete/history/conflicts) with no branching. Only the editing
surface and the export pipeline differ.

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
   (selected repo, active theme, export prefs, scratch-document kind, editor
   line-wrap and viewfinder, **and the Agent Link service origin**). Never
   tokens/secrets. Two pieces of Agent Link state are deliberately *not* in
   `AppConfig` and live in `sessionStorage` instead, because config is shared by
   every tab on the origin:
   - **The on/off switch** (`loadAgentLink`/`saveAgentLink`). In config it was
     shared by the whole origin, so switching it on once armed every tab
     afterwards, they all raced for the bridge, and whichever won became the tab
     the agent drove — leaving the human no way to choose.
   - **The pairing code** (`loadPairingCode`/`savePairingCode`), for that reason
     and one more: it is the name *this tab* answers to, so sharing it across the
     origin would make every tab answer to the same code and reintroduce exactly
     that race.

   Both survive a reload, which a plain `useState` would not — and for the code
   that matters twice over, since coming back under a different one would strand
   an agent holding a code that reaches nothing. **`AppConfig.mcpOrigin` is the
   opposite case and belongs in config**: *where the service is* is a property of
   the deployment, not of one tab, and it is a URL rather than a credential.
4. **Every read/write server action takes a caller-supplied `branch`** — there
   is no fixed branch constant. The selected `{owner, name, defaultBranch,
   branch}` (`RepoRef`, `lib/types.ts`) lives in `AppConfig.repo`;
   `BranchPicker.tsx` lists/creates branches (`listBranches`/`createBranch` in
   `app/actions/github.ts`). "Open PR" is a plain redirect to GitHub's compare
   URL (`compare/{defaultBranch}...{branch}`) — there is no PR-creation API
   surface, and no server-side PR/merge logic of any kind.
5. **The editor, preview and canvas are client components** (`'use client'`). Do
   not SSR them.
6. **Never expose a true force-push.** "Overwrite" on conflict = refetch the
   latest sha, then commit on top of it (`onOverwrite` in `AppShell.tsx`). Do not
   use the git data API to rewrite refs.
7. **Diagrams render with the official `mermaid` library** (`lib/mermaid.ts`),
   on the built-in `base` theme so the global YAML config's `themeVariables` can
   retune it. Rendering is async and browser-only. Any diagram type mermaid
   supports works.
8. **Excalidraw must stay code-split.** The editor bundle is ~1MB plus ~13MB of
   lazily-fetched fonts, and mermaid-only users must never pay for it. It is
   reachable through exactly two doors: `components/Canvas.tsx`'s
   `dynamic(..., { ssr: false })` (which loads `CanvasInner.tsx`, the only module
   allowed to import the component and its CSS) and `lib/exportScene.ts`'s
   per-function `await import(...)`. **`lib/excalidraw.ts` must never
   *value*-import `@excalidraw/excalidraw`** — type-only imports are erased and so
   are fine — because `AppShell` loads it eagerly. Same reason `ExportMenu` may
   only reach the library via `lib/exportScene.ts`.
9. **Scene dirty-tracking is semantic, never byte-for-byte.** Re-serializing a
   scene that was just loaded legitimately changes the bytes (key order, `source`
   rewritten to whichever app wrote it, appState renarrowed), so `text !== baseline`
   would report every freshly opened file as unsaved. `scenesEqual` /
   `sceneSignature` (`lib/excalidraw.ts`) compare the drawing instead, ignoring the
   per-element `version`/`versionNonce`/`updated` churn. `AppShell`'s `dirty` and
   `openFile`'s draft-restore check both branch on kind for this.
10. **The canvas background is chrome, not document content.** It paints the active
    theme's background, but `viewBackgroundColor` is one of the four appState keys
    Excalidraw *does* persist — so serializing what's displayed would rewrite the
    field on every theme change and turn every scene in the repo dirty.
    `CanvasInner.tsx` keeps the file's own value in `storedBackgroundRef` and
    substitutes it back on the way out. Do not persist the displayed color.
11. **Excalidraw renders dark mode as a CSS filter on `canvas`**
    (`invert(93%) hue-rotate(180deg)`), which inverts *anything painted into the
    canvas* — backgrounds included. So any color that must come out exact has to
    live outside the canvas: behind it (the host element, for display) or
    composited around it (for export). Never hand Excalidraw a background color and
    expect it back.
12. **Agent Link: the pairing code is the credential, and TLS is not optional.**
   Protocol 3 deleted the old token route along with the property that used to
   guard it (its *absence* of CORS headers). The service now issues nothing: the
   tab generates its own code client-side and the service buckets by
   `sha256(code)`, so a hostile page can generate a code and pair with itself,
   which is harmless — it cannot guess the user's. What replaces the old rule:
   - **The service URL must be `https:`, or `http:` on `localhost`/`127.0.0.1`
     port 7391.** Enforced on *both* sides, in one implementation each —
     `validateMcpOrigin` (`lib/mcpOrigin.ts`) and
     `internal/config.ValidateMCPOrigin`. Plaintext anywhere else puts the code
     and every document the tab reads on the wire in the clear.
   - **The code never reaches a URL, a query string, or a log line.** Logs carry
     an 8-character prefix of the hash at most.
   - **The TS↔Go wire contract is guarded only by `ideate-mcp/testdata/frames/`.**
     Add a frame, add its fixture in the same change — see §"The wire contract is
     written twice".
   - **Add no CORS configuration to the service.** Its two callers are a browser
     opening a WebSocket (no same-origin policy, so no preflight) and an MCP
     client, which is not a browser.
13. **No agent tool may write to GitHub.** There is no commit tool, and rename and
   delete are deliberately not exposed either, because in this app they *are*
   commits. An agent's blast radius is the uncommitted working copy.
14. **Token refresh happens in `proxy.ts` and nowhere else.** GitHub App user
   tokens expire in 8h and refresh tokens **rotate** (each use invalidates the
   previous one), so a refresh whose result isn't written back to the session
   cookie locks the user out. `cookies().set()` throws during a render, so
   `getGitHubToken()` must stay a pure reader and `auth.ts`'s `jwt` callback only
   refreshes when its lazy-config `request` argument is present (proxy / auth
   route handlers), never when it is `undefined` (RSC render). Do not add a
   refresh path anywhere else, and do not add a DB/KV lock for it — see "Auth".

### A dead session is handled globally, never per-surface

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

### The text editor

`components/Editor.tsx` is one CodeMirror instance for both text kinds, with every
per-document setting swapped through a `Compartment` (language, theme, soft wrap)
rather than by remounting — a remount drops undo history and cursor position on
every file switch. The line-wrap toggle is an app preference
(`AppConfig.wrapLines`), so it survives reloads.

It **does not use `basicSetup`**: that bundle is spelled out as `baseSetup` because
three of its pieces need configuring rather than accepting.

- `autocompletion()` must appear **exactly once**, so the markdown link-target
  completions can be registered as *language data* and reach it. Typing
  `[text](` offers every file in the repo, written relative to the document being
  edited (`relativeLink`), so the result is a link both this app and GitHub
  resolve. The file list and the document's path arrive as a `StateEffect`, like
  the diff baseline — they are the app's state, not the editor's. It is configured
  `{ icons: false }`: CodeMirror renders an icon slot per row but only ships glyphs
  for its own completion types, and `file` is not one, so every path was indented
  by an empty box. And a completion's `detail` is set **only when it differs from
  the label** — a sibling file relativizes to its own name, and for a document at
  the repo root every path does, so an unconditional `detail` printed the same
  string twice on every row.
- `foldGutter` gets a real chevron (`foldMarker`) instead of CodeMirror's bare
  `⌄`/`›` glyph, hidden until the gutter is hovered unless the line is actually
  folded. It is added **at the mount site, after the dirty gutter**: gutters render
  in extension order, and the change bar belongs beside the line numbers.
- `defaultHighlightStyle` and the lint gutter are dropped — this editor has its
  own highlight style, and nothing here lints.

Anything added to that list has to keep the gutter order (line numbers → changes →
folds) and the single `autocompletion()`.

**Every surface CodeMirror paints itself has to be named in `editorTheme`.** The
pieces it does *not* name fall back to a stock theme whose colors are literals
picked against a white editor, and those are what looked broken on dark palettes:
`.cm-searchMatch` (pale yellow), `.cm-selectionMatch` (pale green), and
`.cm-tooltip` — the completion popup — a light card with a `#17c` selection bar.
The tooltip is appended outside the editor's DOM but still receives the editor's
theme classes, so theme rules do reach it. Two related rules:

- **`dark` must be the palette's real mode** (`resolveThemeMode`), not a constant.
  Pinned to `false` a dark palette got the light defaults underneath everything
  the theme didn't override.
- **Translucent accents blend into `--background`, not into transparency.** A
  translucent bright accent over a dark theme composites *toward the accent*, which
  is what washed the selection (and the selected text) out. Mixing into the page
  color keeps a dark palette's selection dark at the same visual strength.

The gutter sits on `--background` rather than `--secondary` for both reasons: the
line numbers are `--muted-foreground`, which is measured against the page (see the
contrast floor), and a mid-tone band down the side of the pane was never the
intent.

### Double-click scrolls the other pane (markdown)

`lib/markdown.ts` stamps every rendered block with the 1-based source line it came
from (`SOURCE_LINE_ATTR` = `data-md-line`), and `MarkdownPreview` + `Editor` each
expose a `revealLine` on their imperative handle; `AppShell` wires the two
double-click handlers to each other's handle. Four things are deliberate:

- **markdown-it already knows the mapping** — every block token carries a `map`.
  Re-deriving it by counting rendered elements is not made correct by care: raw
  HTML, footnotes and nested lists all break the correspondence.
- **The block token stream is flat** (only *inline* children nest), so one core
  rule reaches a paragraph inside a list item inside a blockquote, and the sync
  gets that granularity for free. Closing tokens and `inline` tokens are skipped —
  the latter renders its children, not a tag.
- **Fences are stamped from the other end.** They render as placeholders, so the
  line travels through `FoundFence`/`FoundCode` and is grafted on with
  `withSourceLine` (or, for a standalone diagram, carried as a field on the
  `MarkdownPart` and handed to `DiagramViewport`'s `sourceLine`).
- **It is imperative, not a prop.** A jump is an event: the same line
  double-clicked twice must jump twice, which an unchanged prop cannot express —
  and the nonce workaround re-renders the whole document, every embedded diagram
  included, on each jump.

Neither side calls `focus()`, and the editor's `dblclick` handler returns `false`
so the double-click still selects a word. The sync rides along with the existing
gesture rather than taking it over.

Beside the editor sits the **viewfinder** (`components/Minimap.tsx`,
`AppConfig.minimap`): the whole document compressed into a 64px column, with the
visible region marked and the uncommitted changes banded across it. Three things
about it are deliberate:

- **It is a canvas.** A thousand-line file is a thousand marks, and a thousand
  absolutely-positioned divs would cost more to lay out than the editor itself.
- **The scale is fixed at 3px per line, and the map slides** when the document is
  taller than the column — the same thing VS Code does. Fitting every line into the
  available height instead was the obvious first implementation and it is useless
  past a few hundred lines: each line collapses to a sub-pixel smear. The slide is
  driven by the editor's *scroll progress* (`overflow * progress`), not its scroll
  offset, so the map reaches its own end exactly when the editor reaches the
  document's — and the pointer→document mapping has to add `mapTop` back in, or
  clicking a mark scrolls somewhere else once the map has slid. Only the visible
  slice is drawn, so cost per frame is flat in file size.
- **Its colors are read from computed style at draw time** (`color`, `--diff-*`),
  so it follows the active palette with none of it duplicated here. A theme change
  rewrites custom properties on `<body>` without changing a single prop, so a
  `MutationObserver` on that element is what triggers the redraw.

The scroll geometry comes from the CodeMirror scroller (`scrollDOM`), not from a
line count, so soft-wrapped lines don't throw the viewport marker off; a document
change re-measures through a ref the update listener calls, rather than by
rebuilding the listener on every keystroke. The *first* measurement is synchronous
rather than scheduled — a frame callback never runs while the tab is in the
background, which would otherwise leave the viewport marker at zero height until
something else nudged it.

## UI stack

Prefer shadcn primitives and Tailwind utilities over bespoke CSS.

## Routing / modes

- `/` — marketing landing (`components/Landing.tsx`). Unauthenticated users start
  here and pick **Local mode** (`/editor?mode=local`) or **GitHub repo mode**
  (sign in → `/editor`).
- `/editor` — the app (`app/editor/page.tsx` → `AppShell`). Reads `auth()`:
  signed-in → `mode="github"` (repo features on); `?mode=local` without a session
  → `mode="local"` (editor + export only); otherwise redirects to `/`.

With a file open, its extension picks the editing surface. With nothing open —
local mode, or before picking a file — there is no extension to read, so the user
chooses via a Diagram/Markdown/Canvas toggle backed by `AppConfig.scratchKind`.
**Each kind gets its own localStorage draft slot** (`SCRATCH_DOC_ID` /
`SCRATCH_MARKDOWN_DOC_ID` / `SCRATCH_SCENE_DOC_ID`, resolved through
`scratchDocIdFor`), so toggling parks the current work instead of overwriting it
with content the other surface can't read. Route every scratch-slot lookup through
`scratchDocIdFor` rather than re-deriving it — a fourth kind must not be able to
silently land in another kind's slot. Anything that forces mermaid content into the
scratch doc (`showRepoStartState`, `resetForRepoSwitch`, `detachEditor`) also
resets `scratchKind` to `'mermaid'`.

### Creating a file: only the name is typed

`NewFileMenu` has already chosen the kind by the time the path prompt opens, so
the extension is settled — and the folder is whichever "+" was used. `PromptModal`
therefore shows both as **uneditable** text around the input (`prefix`/`suffix`),
prefills just `untitled`, and selects it, so typing replaces the name and nothing
else. `onSubmit`/`validate` still receive the assembled path, so
`validatePath`/`templateFor(fileKind(path))` are unchanged; `validateNewFilePath`
adds the one new failure mode (an empty name, which would assemble into `.md`).

A name may still contain `/`, so creating a subfolder from the root "+" works.
**Rename is deliberately different** — it keeps a single free-text path field,
because moving a file between folders is the point of it.

**Renaming a never-committed file is local only.** Such a file is spliced into the
sidebar from `pendingPath` and its content is a localStorage draft; GitHub has
nothing under either name, so `renameFile` would ask git to move a path that isn't
in the tree and get a 404 back. `requestRename` branches on
`node.path === pendingPath` and moves the draft slot instead — which is the same
thing creating it under the new name would have done — skipping both the API call
and the tree refresh, since the branch didn't change. The committed path still
lands on GitHub *first*: reordering that would leave the app pointing at a path the
repo never got.

Markdown is listed **first** in `NewFileMenu` and in the scratch-kind toggle: a
document is the most common thing to start, and it can hold diagrams of either
kind inside it.

### Selecting a repository is a precondition, not a setting

Signed in with `config.repo === null` the app can do nothing — no tree, no open,
no commit — so `AppShell` opens `RepoPicker` automatically once per mount rather
than leaving an inert editor on screen. It is a ref-guarded one-shot, so
dismissing it to use the local scratch document doesn't reopen it immediately.

A **fresh sign-in always clears the stored repository**: `loginWithGitHub`
redirects to `/editor?connect=1`, and the hydration effect consumes that flag,
nulls `repo`, persists it, and strips the param via `history.replaceState`.
Stripping matters — without it a reload (or a shared link) would wipe the
selection the user just made. `?mode=local` never carries the flag.

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

## Repository layout

Two programs, two languages, one repo:

```
package.json          thin root: scripts delegating into app/, plus mcp:*
app/                  the Next.js app — every path in this document is relative
  app/                …to here, so the router lands at app/app/
  components/ lib/ public/ scripts/ types/
  auth.ts proxy.ts next.config.ts tsconfig.json package.json .env.local
ideate-mcp/           Go: the Agent Link MCP server + tab relay
  cmd/server/ internal/ testdata/frames/ Dockerfile README.md
```

**`app/app/` is not a typo.** The package directory and Next's router directory
share a name; it is standard in monorepos and mildly confusing on first read.

Only one JS package remains, so there are **no npm workspaces** — the root
`package.json` holds no dependencies and delegates with `npm --prefix app`. Its
`postinstall` runs the app's install, so a bare `npm install` at the root still
works. `.env.local` lives in `app/`, because that is Next's working directory.

## Non-obvious file facts

- `proxy.ts` — Next 16 request hook (the old `middleware.ts` convention);
  `export { auth as proxy }`. Never redirects; local mode passes straight through.
- `components/Canvas.tsx` — sets `window.EXCALIDRAW_ASSET_PATH` *before* the
  lazy chunk loads; ordering matters.
- `components/icons.tsx` — ships the Mermaid, Markdown and Excalidraw brand
  marks taken from each project's own favicon, normalized to bare filled glyphs
  in `currentColor`: no badge, no brand hue, so the three read as one family and
  follow the active theme.
- `app/actions/github.ts` — ALL GitHub I/O.
- `lib/highlight.ts` — the only module that touches shiki, always through
  `await import`. Type-only imports are erased, so those are fine.
- `lib/diff.ts` — the diff algorithm and nothing else; no React, no I/O.
- `lib/color.ts` — static color arithmetic (parse / luminance / contrast / mix /
  `ensureContrast`). No DOM: it must work on a color *before* it becomes a CSS
  string, which is why `applyThemeToSite` blends numerically instead of emitting
  `color-mix()` for anything it then has to measure.
- `lib/agentProtocol.ts` — Agent Link's wire contract, hand-mirrored in Go. It no
  longer has to compile under two tsconfigs (the old constraint), but every frame
  it declares needs a fixture in `ideate-mcp/testdata/frames/`.
- `lib/mcpOrigin.ts` — the TLS rule for the Agent Link service origin, and the
  `ws://`/`wss://` derivation. Mirrored by `internal/config.ValidateMCPOrigin`,
  whose test carries the same cases.
- `lib/agentFrames.test.ts` — the only vitest file in the app, and the TypeScript
  half of the cross-language wire guard. Its frames must stay hand-written
  literals: deriving one from the fixture it is compared against would assert that
  a file equals itself.
- `ideate-mcp/` — a separate Go module, not part of any tsconfig. Unlike the Node
  server it replaced it may log freely, since stdout is no longer a JSON-RPC
  channel; it logs structured JSON to stderr anyway.
- `types/markdown-it-emoji.d.ts` — the plugin ships no types.

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

### A diagram palette is not a text palette — hence the contrast floor

`themeVariables` describes a *diagram*: `primaryBorderColor` is a node outline,
`lineColor` an edge. `applyThemeToSite` maps those onto tokens that carry **text**
— `--primary` is the editor's keyword/heading color and the fill behind a primary
button — and a color that reads fine as a 1px stroke can be 2.3:1 against the page
(Zinc's `#A1A1AA` on white; `#52525B` on `#18181B`). That was the editor's
"unreadable on many themes" bug, and it was never a CodeMirror problem.

So every token that ends up holding words is passed through `ensureContrast`
against **the surface it is actually painted on** (`legible` in
`applyThemeToSite`): AA 4.5:1 for text, 3:1 for `--ring`, which is a graphical
object rather than text. Three properties to preserve:

- **A passing color is returned untouched**, so a well-chosen palette renders
  exactly as authored and only unusable colors move.
- **The lift blends toward white or black**, not toward another hue, and bisects
  for the smallest blend that clears the floor — a blue accent stays blue, it just
  stops being the same lightness as the paper.
- **`--border` / `--input` are deliberately excluded.** A hairline you can barely
  see is the intent there; enforcing text contrast on it would draw boxes around
  the whole UI.

Unparseable notations (`hsl()`, named colors) fall through unchanged — the theme
pipeline is best-effort, and `lib/color.ts` reads only hex and `rgb()`.

`--muted-foreground` is the one derived value: the palette's text blended 60% over
the *background* (statically, via `mixColors`, because `ensureContrast` needs
numbers and a `color-mix()` string is opaque to it), then lifted back to AA. The
CSS `color-mix()` form survives only as the fallback for a palette we can't parse.

### Markdown documents borrow the same config

A ```mermaid fence inside a `.md` renders through the very same `renderToSvg` and
the very same global config, so an embedded diagram is themed identically to a
standalone one — the Theme *and* Layout dropdowns and the config cogwheel all stay
visible for markdown for exactly that reason (`kind !== 'excalidraw'` in
`AppShell.tsx`). **The config is injected at render time and never written into
the document**: the file in the repo holds bare ```mermaid fences, which is what
lets GitHub render it too. Only the "Markdown + Theme" export bakes it in, into a
copy.

Embedded diagrams get the same zoom/pan/fit controls as the diagram pane, because
they are literally the same component. To make that possible `renderMarkdown`
returns a **list of parts** (`MarkdownPart[]`) rather than one HTML string:
`MarkdownPreview` renders each prose run as a `dangerouslySetInnerHTML` div and
each diagram as a real `DiagramViewport` sibling, so React owns every diagram
outright.

**Do not go back to portaling a viewport into a node that innerHTML created.**
That was tried and it fails: React replaces the whole subtree when the HTML
changes, so the portal keeps rendering into a node it has already detached — the
SVG lands in an orphan and the document shows an empty box. The bug is invisible
to typecheck and only reproduces on re-render.

Splitting is only legal at `token.level === 0`. A fence nested in a list item or
blockquote sits between an unclosed `<ul>`/`<blockquote>` and its closing tag, so
cutting there would produce two fragments of invalid HTML — those stay **inline**
as plain SVG (rendered and themed identically, just without zoom controls), as do
fences that fail to parse. Hence the prose runs are wrapped in `.md-prose-run`,
which is `display: contents` so its children still lay out and match the
`.md-prose > *` selectors as if they were direct children.

**A maximized viewport must be opaque.** "Fill window" turns the box into a
`fixed inset-0` overlay, so whatever `background` resolves to becomes the whole
screen — and an *omitted* background (the natural value for an inline figure that
should show the document through it) left the editor and prose visible around the
diagram. `DiagramViewport` therefore substitutes an opaque fallback whenever it is
maximized with no background (or `'transparent'`), and `Preview`/`MarkdownPreview`
each resolve one surface color that they use for their own pane *and* hand to the
diagrams on it, so the two can't disagree. The fallback is white, not
`var(--background)`: an untuned diagram uses mermaid's dark-on-light default
palette and would be unreadable on a dark surface.

`DiagramViewport`'s one behavioral fork is the wheel: full-pane zooms on a bare
wheel, embedded requires Ctrl/⌘ (the platform zoom modifier, and what a trackpad
pinch reports). An embedded diagram sits inside a scrolling document, so trapping
a bare wheel would turn every diagram into a scroll dead-zone. Maximized, an
embedded figure owns the screen and reverts to bare-wheel zoom.

The prose itself is styled by `.md-prose` in `app/globals.css`, written against
the shadcn tokens rather than literal colors, so a rendered document follows
`applyThemeToSite` like the rest of the chrome. Diagrams render **sequentially**,
not through `Promise.all`: mermaid re-`initialize()`s one global instance and
measures against the live DOM, so overlapping renders are a race with nothing to
gain. Code fences have no such constraint and are highlighted in parallel.

#### Rendering a document the way GitHub does

markdown-it runs with **`html: true`**, plus footnotes, `:emoji:` shortcodes,
task lists, `> [!NOTE]`-style alerts, GitHub-compatible heading slugs, and shiki
syntax highlighting. Raw HTML matters because real repo documents are full of it
(`<details>`, `<kbd>`, alignment wrappers), and escaping it showed the markup
instead of the content.

That makes **sanitizing the boundary that keeps a `.md` file from running script
in the app**, and it fixes the order of the passes in `renderMarkdown`:

1. markdown-it renders, emitting a `<span data-md-mermaid|data-md-code="N">`
   **placeholder** for every mermaid fence and every highlighted code fence.
2. The whole string goes through DOMPurify (`sanitizeHtml`) — `<style>` and
   `<form>` on top of its defaults, `<input>` deliberately allowed for task-list
   checkboxes.
3. *Then* the placeholders are swapped for our own trusted markup.

So the sanitizer never sees mermaid's SVG or shiki's token spans (it would mangle
them), and the document's own HTML never escapes it. Placeholders are elements
rather than HTML comments precisely because the sanitizer strips comments — but
once substitution starts, nothing sanitizes any more, which is why the top-level
mermaid split marker *is* a comment. `sanitizeHtml` returns `''` when there is no
DOM: rendering is browser-only by contract, so that is a caller bug, and failing
closed is the only safe answer.

Two traps in shiki's output, both of which show up as an oddly airy code block:
it separates its `<span class="line">`s with **real newline characters** (so the
block still copies as text), which in a `white-space: pre` context *are* the line
breaks — giving those spans `display: block` on top of them breaks every line twice
and double-spaces the whole block. And the fence content markdown-it hands over
still carries its closing newline, which shiki faithfully renders as one more empty
line; `highlightCode` trims it. Code blocks also set their own `line-height`, since
`.md-prose`'s 1.7 is leading for sentences and leaves code looking double-spaced.

**shiki is lazily imported** (`lib/highlight.ts`) and only when a fence carries a
language — a prose-only document, and every mermaid-only user, pays nothing. It
runs on the JS regex engine rather than Oniguruma (no WASM payload), loads both
GitHub themes up front and picks one from `resolveThemeMode`, and its own `pre`
background is stripped so the block keeps the themed `.md-prose pre` surface.
Highlighting failures return `null` and fall back to the plain fence.

#### The document is wired into the repository

`renderMarkdown` takes the document's own path and the repo, and resolves
relative links and images the way GitHub does:

- A **repo-relative link** is tagged `data-md-repo-link="<resolved path>"`, and
  its `href` is rewritten to the file's GitHub blob URL. `MarkdownPreview`
  intercepts a plain click and opens the file in the editor; ⌘/Ctrl-click still
  follows the href to GitHub. The href rewrite is not cosmetic — left as a
  relative path, an "open in new tab" would navigate to a 404 *under `/editor`*,
  which is why a click is `preventDefault`ed outright when no repo is connected.
- **Following a link is undoable.** `AppShell` keeps a `linkTrail` of the files a
  link was followed *from*, and shows a Back button while it is non-empty. Only
  link navigation pushes onto it — opening a file from the tree clears it, because
  a Back button that then jumped to an unrelated file is worse than none.
- **Resting on such a link previews the file** (`components/FileHoverCard.tsx`):
  fetched through `readFile`, cached per repo+branch+path, rendered from a
  truncated copy of the source, and `pointer-events: none` so the card never has
  to negotiate hover with the link that opened it. A scene shows its element
  count — drawing a real thumbnail would mean pulling in the Excalidraw bundle
  and its fonts (rule 8) for a hover preview. Scrolling **re-measures** the card's
  anchor rather than dismissing it: dismissing while the pointer still rested on
  the link left the next mouse event free to schedule it again, which flickers.
- A **relative image** is rewritten to raw.githubusercontent.com, since a
  repo-relative `src` would otherwise resolve against the app's own origin.
- `#anchor` links scroll the reading pane, using the heading slugs.

#### Full-window markdown gets an outline

`renderMarkdown` returns `{ parts, headings }`, and maximizing the preview turns
it into a reading view with a Contents panel (scroll-spy on the pane's own scroll
container). It is deliberately **only** offered when maximized: beside the editor
the pane can't spare the width, and the document is right there in the source. The
panel **floats over** the document rather than taking a column of it — a column
shifts the prose and re-fits every diagram in it each time the panel is toggled —
and it sits at the top right, directly under the window controls, so the panel and
the button that opens it are in the same place.

Filling the window covers the toolbar, so the reading view carries its own **Back**
button (`onBack`/`backLabel`) for the link trail described above. Anything else the
toolbar owns and a reader needs has to be repeated there for the same reason.

### Native chrome follows it too (scrollbars, `color-scheme`)

Two things are easy to get wrong here, and both were:

- **`scrollbar-color` is inherited, so it must be declared on `*`.** Declared once
  high up, it resolves *there* — against the fallback palette in `:root`, not the
  tokens `applyThemeToSite` writes onto `<body>` — and every descendant inherits
  that already-computed color. The `*` rule makes each element resolve the vars
  against its own values.
- **Standard properties only**, with `::-webkit-scrollbar` kept behind
  `@supports not (scrollbar-color: auto)`. Chromium ignores those pseudo-elements
  as soon as `scrollbar-width`/`scrollbar-color` is set, so shipping both
  unconditionally made a scrollbar's appearance depend on the browser and the
  platform's overlay-scrollbar behavior — the intermittent theming this replaced.

`applyThemeToSite` also sets **`color-scheme` on `<html>`** (not `<body>`) from
`resolveThemeMode`: it decides how the browser paints the UI it draws itself — the
window scrollbar, form controls, scrollbars inside subtrees the app's CSS can't
reach — and the window scrollbar belongs to the root element.

### The canvas follows the same palette

Excalidraw's theme is a binary light/dark switch, not an arbitrary palette, so the
canvas takes the *mode* of whichever diagram theme is active — `resolveThemeMode`
uses the matched preset's declared `mode` when the palette is one of the built-ins
and falls back to the background's WCAG relative luminance (threshold ≈ 0.179, the
point where white text starts out-contrasting black) for hand-edited
`themeVariables`.

Three pieces make the canvas look like part of the app rather than an embed:

- **Background.** Painted on the *host element behind* the canvas, not handed to
  Excalidraw — see rule 11. `themeBackgroundColor` supplies the color and the
  canvas itself is cleared to `transparent`, so the surface renders at the exact
  theme color while the *drawing* still gets the dark-mode inversion that keeps
  strokes legible on it.
- **Chrome.** `app/globals.css` remaps Excalidraw's own CSS custom properties
  (`--island-bg-color`, `--text-primary-color`, `--color-surface-*`,
  `--color-primary-*`, borders, buttons) onto the shadcn tokens `applyThemeToSite`
  writes to `<body>`. Those rules are prefixed with `body ` **on purpose**: they
  have to beat Excalidraw's own `.excalidraw.theme--dark` on specificity, and
  stylesheet order isn't guaranteed since Excalidraw's CSS arrives with the lazy
  chunk. Color *swatches* are deliberately left alone — they opt into
  `--theme-filter`, which is how Excalidraw shows stored light-mode colors in a
  dark UI.
- **Main menu hidden.** Its items were either redundant with app chrome (export
  lives in the Export menu; saving is Commit) or app-controlled (canvas
  background). The CSS targets `.main-menu-trigger` — **not**
  `dropdown-menu-button`, and not that `data-testid`, both of which the toolbar's
  "More tools" trigger also carries. Matching on those hides the frame/embed/laser
  tools instead of the menu.
- **Right-click menu restyled.** Excalidraw's context menu is its own component, so
  it can't be swapped for `components/ui/dropdown-menu.tsx` — `globals.css` instead
  `@apply`s the very same utilities `DropdownMenuContent`/`Item`/`Separator` use, so
  the two can't drift apart. Remapping variables wasn't enough here: it hardcodes a
  `#adb5bd` separator, `#f03e3e` danger text and a `--button-gray-3` border, and its
  hover *inverts* (highlight fill + popup-colored text) where shadcn tints.

**The read-only preview strips what's left.** A `viewMode` canvas (the history
panel's version preview) gets `canvas-host--view-mode`, which hides
`.App-menu_bottom` (zoom + help) and `.App-bottom-bar`. Two traps live here:

- Excalidraw switches to its **mobile** layout below ~730px, and the history sheet's
  preview pane is narrower than that — so `.App-bottom-bar` appears, holding nothing
  in view mode, and reads as an empty white card over the drawing.
- Unlike the other menus, `.App-bottom-bar` is a direct child of `.excalidraw`, not
  of `.layer-ui__wrapper`, so a selector aimed at the menu containers misses it.

Both rules must stay scoped to view mode: while *editing* at a narrow width,
`.App-bottom-bar` is where the mobile property panel lives. `renderTopRightUI` (the
fill-window button) is omitted in view mode too — that preview sits inside the
history sheet, so filling the window would cover the sheet that opened it and leave
the button as the only way back.

`CanvasInner.tsx` also imposes `exportScale: 3` (Excalidraw's own maximum) so its
built-in right-click "Copy as PNG" isn't left at the display's `devicePixelRatio`,
and re-frames the scene with `scrollToContent` on mount — scroll/zoom are
deliberately *not* persisted (panning must not dirty a file), so a reopened scene
would otherwise land at the canvas origin.

## Uncommitted changes are shown as a diff

`lib/diff.ts` is a Myers line diff (what git uses), with a common prefix/suffix
trim first and a size cap after it — past `MAX_DIFF_LINES` the result degrades to
"all of the old, then all of the new" rather than spending seconds and hundreds of
megabytes proving that two large files are unrelated. **No GitHub call is
involved**: the app already holds the committed content it loaded (`baseline`)
beside the working copy, so a diff of the open document is pure computation.

It feeds three surfaces:

- **The editor's dirty gutter** — a bar beside the line numbers, VS Code style
  (`lineChanges`). The unit is a *block* of adjacent changed lines, not a line:
  removals and additions together are a **modification**, additions alone are an
  **addition**, and removals alone have no line in the working copy to mark, so
  they mark the line that now sits where they were. The map is computed in React
  and pushed into CodeMirror as a `StateEffect`, because the baseline is the
  *app's* state — it changes on commit, restore and file switch, none of which are
  document changes the editor would otherwise see. The gutter is empty when
  `loadedSha === null`: a file with no commit behind it has nothing to diverge
  from, and marking every line green is noise.
- **A peek popup** on clicking a marker (`changeAtLine`), positioned from
  `coordsAtPos` and re-pinned on scroll. The gutter's `mousedown` handler returns
  `true` so the click doesn't also move the cursor, and the marker widens with a
  `scaleX` on hover — a real width change would reflow the gutters beside it. The
  popup's **Revert** discards that one block: every kind of change is reduced to a
  single `LineChangeRevert` ("replace these lines with this text") in `lib/diff.ts`,
  so `applyRevert` in the editor has one operation to perform rather than three
  cases to re-derive. Its two line-break subtleties are invisible in the line range
  and easy to lose: deleting lines has to take a line break with them, and
  inserting at the end of the document puts the break *before* the text. It goes
  through `dispatch`, so ⌘Z undoes it like any edit.
- **`components/DiffView.tsx`** — side-by-side (default) or unified, from the same
  hunks. Used by the editor's diff toggle (committed vs. working copy, taking the
  whole pane row) and by version history's Preview/Diff toggle, which compares the
  selected version either with the one before it or with the working copy.

Scenes are excluded everywhere: a `.excalidraw` file is JSON whose bytes churn
without the drawing changing (rule 9), so a line diff of one shows changes that
aren't there.

In version history, "previous version" is the next commit in the **loaded** page.
"No older commit here" is ambiguous — first commit of the path, or next page not
fetched yet — so the fetch effect only claims the file was created in this commit
when there is genuinely nothing more to page in; otherwise it asks the user to
load more history.

## Agent Link — an agent drives the live editor

**The beta label is gone from the UI** (it was a badge on `AgentLinkModal`'s title
and a word in every toolbar tooltip), so the licence it carried — change
`PROTOCOL_VERSION` and the tool surface with no migration path — is gone with it.
What has not changed is the mechanism: the two sides refuse to talk on a mismatch
(`CLOSE_PROTOCOL_MISMATCH`), so a bump is a loud, diagnosable break rather than a
silent one. Which means **ship both ends of a bump together** — a version skew now
strands a user who has no label telling them to expect it.

`ideate-mcp/` is a Model Context Protocol server that hands a coding agent **the
document open in the browser right now**, not a file on disk. That is the whole
point: the agent edits, mermaid renders, and the renderer's verdict comes back in
the result of the agent's own tool call, so a broken diagram gets fixed in the same
turn. An agent editing files finds out when a human next opens them.

### One remote service, and why the socket turned around

```
agent ──MCP Streamable HTTP──► ideate-mcp (Go) ──WebSocket──► browser tab
```

Until protocol 3 this was inverted: the MCP server was a Node process on the user's
own machine that **listened** on `ws://127.0.0.1:7391-7395`, and the tab dialled out
to it. That was forced rather than chosen — a web page cannot open a listening
socket — and it had to go, for reasons no amount of care would have fixed:

- **Safari could not use it at all.** No loopback exemption for mixed content, so
  `ws://127.0.0.1` from an `https://` page is blocked outright. Chrome's Local
  Network Access work is heading the same way.
- **Only an agent on the same machine could reach the tab.** Containers,
  Codespaces, SSH boxes and browser-based agents were all impossible.
- Everything awkward about the old design — the port walk, the `Origin` allowlist
  doing security work, the whole JWT/JWKS apparatus — existed *only* to make a
  loopback listener safe. Inverting the socket deleted all of it in one go.

The tab is still the WebSocket client; it just dials a service instead of loopback.
**A pairing code the tab generates, and the human hands to their agent, joins the
two halves.** The honest cost, and it belongs in the README: **Agent Link no longer
works offline.**

`lib/agentProtocol.ts` is the wire contract. It has lost its old "must compile under
two tsconfigs" rule — the app is its only TypeScript consumer now — and gained a
cross-language mirror in its place; see below.

### Which tab, and whose decision

Two deliberate steps gate this, one on each side, and they answer different
questions. This is unchanged by the transport, and it is the part most worth not
breaking.

**Which tab** is the human's answer, given by switching Agent Link on there and
handing over that tab's code — hence the per-tab `sessionStorage` scoping in rule 3.
One code holds one tab (`CLOSE_SLOT_TAKEN` turns away any second one), so the
service never chooses.

**Whether to drive it** is the agent's answer, given by calling `ideate_connect`. A
paired tab is parked as *waiting* and every command that touches the document is
refused until then, because a pairing code existing is nobody's decision: adopting
whichever tab was paired would mean editing a human's document with no one having
chosen to. `ideate_status` is the one tool allowed through unattached, and it returns
metadata only — never content — so an agent can say what attaching would give it
without first helping itself.

`lib/agentLink.ts` therefore has these live states, and conflating them makes the
toolbar lie: `paired` (this tab holds its code, nothing can touch the document) is
not `attached` (an agent claimed it and can edit now).

**`full` is its own state and not a flavour of `blocked`**, because the two want
opposite behaviour. `blocked` (a protocol mismatch) means retrying is pointless;
capacity frees up, so it is not — but hammering a full service is not how to wait
for it either. So `full` stops the automatic loop and waits for an explicit Retry,
which also holds the message still long enough to read.

### Security: the code is the credential

WebSockets have **no CORS and no same-origin policy**, and that fact used to drive
the whole design. It no longer does, because there is nothing on the socket worth
claiming: the service issues nothing, holds nothing durable, and buckets purely by
`sha256(code)`. A hostile page can generate its own code and pair with itself, which
is harmless. It cannot guess the user's.

So the old "the security is the absence of CORS headers on the token route" property
did not move — it **disappeared**, along with the route. What carries the weight now:

1. **The pairing code**, 8 characters of Crockford base32 (2^40), which only holds up
   because guesses are rationed: a per-IP token bucket on `/mcp` and `/v1/tab`, plus a
   much tighter per-IP counter on codes matching no tab. The general limiter has to run
   *before* the body is parsed, since the code arrives as a tool argument and cannot be
   read until after — which is why it is keyed on the address rather than on the code.
2. **TLS**, per rule 12, enforced on both sides in one implementation each.

The `Origin` allowlist on the tab handshake survives as a **soft** control: it stops
the service being used as free infrastructure by unrelated pages. It is not the
security control, and the code comments say so — a browser cannot forge `Origin` but
a local process can, and neither can guess a code.

**There is no commit tool, and rename/delete are not exposed either** — in this app
those *are* commits (`renameFile`/`deletePaths` push to the branch), so exposing them
would break the guarantee that an agent cannot write to the user's repository.
`ideate_create_file` is offered because it is genuinely local: it does exactly what
the create prompt does, leaving an uncommitted document with `loadedSha === null`.
The blast radius is the working copy: on screen, and one ⌘Z away.

The standing risk is prompt injection, and none of this changes it: an agent reads
documents from the user's repo, and a `.md` file can contain instructions aimed at
it. That is why there is no commit tool.

### The code is a tool argument, not a header — and that is the point

Every tool takes a required `code`. An `Authorization: Bearer` header is the more
standard remote-MCP shape and would keep the credential out of the model's context,
but a header lives in client config — so switching which tab is driven would mean
re-running `claude mcp add` and tearing down the MCP connection. **Switching tabs
mid-session is a hard requirement**, and only an argument gives it: the human names a
different code and the next call lands on a different tab.

The `code` argument's *description* is what makes that work in practice, so keep its
last clause. Accepted costs: the code appears repeatedly in agent transcripts (the
same exposure as typing it into chat), and the bucket cannot be resolved until the
body is parsed.

MCP runs **stateless** — no `Mcp-Session-Id` binding, since every request carries its
own code. That removes a map and a session lifecycle. It does *not* make the service
stateless: the registry of live tab sockets is irreducible, and both ends of a pairing
must live in one process to be piped. Hence no Redis, no Postgres, and no horizontal
scaling without sharding — and no datastore either, because every record describes a
connection that dies with the process.

Losing the stateful session is why **attachment needs an idle timeout**: a stateful
server would detach on client teardown for free, and without it a killed agent leaves
the toolbar claiming somebody can edit the document. It is wanted regardless — a
stateful client can also vanish without a clean teardown.

### Two things the transport cannot say out loud

- **529 cannot reach a browser.** A rejected WebSocket handshake surfaces in the tab
  as `onclose` 1006 with an empty reason, indistinguishable from the service being
  down. So the capacity refusal reaches the tab as `CLOSE_SERVICE_FULL` on an
  **accepted** socket, and the readable 529 lives on `/v1/capacity` where a
  non-browser client can see it.
- **A grace-window rejoin must re-send `attached`.** A bucket outlives its tab socket
  by `TAB_GRACE`, so a reload keeps the agent's attachment — but the reloaded tab has
  no memory of it, and without the re-send the toolbar would show nobody attached
  while an agent carried on editing.

### The wire contract is written twice

`lib/agentProtocol.ts` and `ideate-mcp/internal/protocol` are hand-mirrored, and the
compiler that used to hold them together is gone. `ideate-mcp/testdata/frames/` is
the replacement, and it only works if all three locks are held:

1. `lib/agentFrames.test.ts` builds each frame as a **typed TypeScript literal** and
   asserts it deep-equals the fixture. `tsc` checks the literal, so moving the TS types
   forces a change here.
2. The Go tests decode every fixture with `DisallowUnknownFields` and re-encode it. A
   field Go is missing, has misnamed, or drops on the way out fails.
3. **A frame with no fixture is checked by neither**, so add the fixture in the same
   change as the frame. A fixture written afterwards is written against whatever the
   code already does, which is what it was supposed to be checking.

Round-tripping is why optionality is load-bearing on the Go side: `read` with no
`path` and `scene_get` with `full: false` have their own fixtures precisely because a
bare `string`/`bool` with `omitempty` round-trips both of them wrong.

### Edits land as CodeMirror transactions, and the echo guard is why they survive

`EditorHandle` (`components/Editor.tsx`) resolves every anchor against the live
document and dispatches **one** transaction, so a batch is one undo step, the
untouched parts keep their folds and cursor, and the dirty gutter and viewfinder
update through the paths they already use. `resolveEdits` (`lib/textEdit.ts`) is
shared with a fallback that goes through `setText` for when no editor is mounted
(a canvas is open, or the diff view has the pane) — refusing there instead would
make the tools mysteriously unavailable whenever the human was reading a diff.

Two things here were bugs found by running it, not by typechecking:

- **`emittedRef` — the echo guard.** The reconcile effect cannot tell an *external*
  `value` change (open a file, restore, `ideate_write`) from an *echo* of the
  editor's own output by value alone. React can commit a render carrying an older
  value *after* a newer programmatic edit already moved the document, and
  force-replacing the document with it silently discards that edit. Two agent edits
  arriving faster than React commits lost **every second one**. So the editor keeps
  a short history of what it emitted and drops an incoming value it finds there.
  Do not collapse this back into a single `lastValue` ref.
- **Diagnostics run on the text the edit *produced*.** `applyEdits` returns the new
  document and `check(text)` takes it, because `setText` only reaches React on the
  next render — reading state back here reported on the document as it was *before*
  the edit, so breaking a diagram looked clean and fixing it looked broken.

**Known, unfixed:** `ideate_write` immediately followed by `ideate_edit` can race.
`writeText` goes through React state while `applyEdits` resolves anchors against the
*live* CodeMirror document, so the edit can look for text the editor has not received
yet and fail with "oldText not found". It predates protocol 3 and the remote
transport makes it *less* likely, not more. The fix, if it is wanted, is to route
`writeText` through the editor handle when one is mounted.

### Scene edits go through `setText`, and route their own arrows

`lib/sceneEdit.ts` reaches `@excalidraw/excalidraw` only through a per-function
`await import` (rule 8), and hands back scene *text* — `CanvasInner` already ingests
an external `value` via `updateScene`, so dirty tracking (rule 9) and the file's own
stored background (rule 10) keep working with nothing added. Never a canvas ref.

**`convertToExcalidrawElements` binds arrows but does not route them.** Handed
`start`/`end` with no points it emits a 99px stub at the canvas origin: correctly
bound, and invisible nowhere near the shapes it joins. So geometry is computed here
(centre to centre, trimmed to each box edge plus a gap) and the binding is wired by
hand in both directions — `startBinding`/`endBinding` on the arrow *and* an entry in
each target's `boundElements`, or dragging the shape leaves the arrow behind. Doing
it ourselves is also what lets an arrow attach to something already on the canvas,
which the converter cannot do (it only resolves ids inside its own batch).

The tool schema flattens the add/update/delete union into one object, because a JSON
Schema generated from a Go struct cannot express a discriminated union. That loses the
schema's ability to say "id is required for update"; `internal/tools.sceneOps` says it
instead, in a message naming the op and the missing field. A worse schema and a better
error — and the error is what the agent actually reads when it gets it wrong.

### Running it

The service is remote, so an MCP client needs a URL rather than a command:

```
claude mcp add --transport http ideate https://<service>/mcp
```

Run once. After that the **pairing code** is the only thing that changes, and it is
how the human points an agent at a different tab. A stdio-only client can front it
with `npx mcp-remote https://<service>/mcp`.

Locally, from a checkout:

```bash
npm run mcp:dev        # go run ./cmd/server on :7391
npm run dev            # the app
claude mcp add --transport http ideate-local http://localhost:7391/mcp
```

Without a checkout, the service is published as
`docker.io/hasathcharu/ideate-mcp` and takes no configuration:
`docker run --rm -p 7391:7391 hasathcharu/ideate-mcp`. The same command is
offered inside **Agent Link → Advanced options**, beside the field that points the
tab at the result — the docs link there is for the environment variables, not for
the one line that gets you running.

Then point the tab at it in **Agent Link → Advanced options**. `http://localhost:7391`
is the one plaintext origin either side accepts (rule 12); 7391 is the old bridge
port, kept because it is the number in everyone's muscle memory.


## Export

mermaid bakes literal colors and a self-contained `<style>` block into the SVG at
render time, so the markup already stands alone — `lib/export.ts` only normalizes
dimensions (mermaid emits `width="100%"` + a viewBox), adds XML namespaces, and
optionally paints a background (white/black/the active theme's own background
color). Both exporters (SVG / PNG) share the single `resolveStandaloneSvg` step;
PNG rasterizes it via `Image` → `<canvas>`. Exporting the mermaid source
(`exportSource`/`copySource`) bakes the global YAML config in as a real
frontmatter block via `buildExportSource`, so the `.mmd` file stands alone too.

### Markdown exports the source, not a rendering

A markdown document already *is* the portable artifact — GitHub and every other
renderer draw the ```mermaid fences themselves — so there is no render step and no
image format. The menu offers a single **Markdown** row (download + copy) that
emits the document verbatim. The background swatches are hidden for markdown: the
output is text, so there is no surface to paint.

Deliberately *no* theme-baking variant: the theme is a render-time concern, and
an export that rewrote every fence to carry `themeVariables` would hand the user
a file that no longer matches what is in their repo.

PNG resolution comes from `rasterScale(width, height)` (`lib/export.ts`), shared by
both exporters so the two formats don't differ in density. It is size-aware on
purpose: a flat device-pixel multiplier makes output density proportional to the
*diagram*, so a small diagram lands in a small image — which is what reads as a
low-quality export. It scales toward a 2400px long edge, with a 3× floor for big
diagrams and a hard 8192px-per-side cap, because an over-large canvas request fails
outright rather than degrading.

### Scenes export through Excalidraw's own exporters

`lib/exportScene.ts` is a separate module, not a branch inside
`resolveStandaloneSvg`: `exportToSvg` already inlines the fonts it used and emits
explicit dimensions, so scene SVGs stand alone with no normalization. Two things
about it are non-obvious and easy to regress:

- **The background is always composited by us**, with `exportBackground: false`
  passed to Excalidraw. Per rule 11 its dark theme wraps the background in the
  filter too, so asking Excalidraw to paint a color returns the hue-rotated inverse
  of the one requested. SVG nests the filtered `<svg>` inside a plain outer one with
  a background `<rect>`; PNG draws the transparent canvas over a filled one.
- **The two formats gate dark rendering on different fields.** `exportToSvg` reads
  `appState.exportWithDarkMode` (it sets `filter` on the SVG root); the canvas
  renderer behind PNG checks `appState.theme === 'dark'`. Set **both**, or the two
  formats disagree.

The chosen background also decides the *theme* of the export, since light-mode
strokes on a dark surface are invisible: "Black" yields light-on-black, "White"
dark-on-white, "Theme" follows the palette. Transparent is the one case with no
surface to judge, so it follows the active theme's mode instead — reading the
scene's stored canvas color there would always answer "light", because that value
is the file's own and the displayed background is theme-driven chrome the file never
records (rule 10).

## Conventions

- TypeScript strict; server actions return `ActionResult<T>` so the client can
  branch on errors (especially `kind: 'conflict'` for 409/422, and
  `kind: 'unauthenticated'` for 401 / a dead session) without try/catch.
- Keep server-only code out of client bundles; `lib/session.server.ts` imports
  `server-only` as a guard.
- **`useDebouncedValue` must stay keyed on the open document** (`docId`). It takes a
  `resetKey` that adopts the incoming value immediately when it changes; a delay
  only makes sense while editing *one* document. Unkeyed, everything downstream
  (preview, export, the draft autosave) sees the *outgoing* document for a full
  delay window — which rendered mermaid's parse-error dump for the scene JSON on
  every canvas→diagram switch, and wrote the previous file's text into the new
  file's localStorage draft slot.
- **The scratch/file draft is written only while the document is dirty**, and
  cleared the moment it isn't (the autosave effect in `AppShell`). Saving
  unconditionally persisted the auto-inserted starter template as a draft as soon
  as it was displayed; that draft then won on every later load, so anyone who had
  merely *opened* a scratch document was pinned to the template text of that day
  and edits to `templateFor` never reached them. Keep the `dirty` gate on any new
  autosave path.
- **`refreshTree` never blanks the list.** Discarding the stale list is the caller's
  decision, and only the first load and a repo/branch switch
  (`resetForRepoSwitch`) want it; the incidental refreshes after a
  commit/delete/rename keep the list up and swap it when data arrives. A refresh
  that *fails* while a list is on screen shows an inline banner and keeps the list.
  `treeLoading` is tracked separately from `tree === null` for exactly this reason.
- Loading states for lists use `components/ui/skeleton.tsx` with per-call-site
  geometry that mirrors the real rows (indent, padding, line count), so content
  doesn't jump when it swaps in.
- **A list whose rows have both a hover fill and an active tint needs a pixel of
  gap between them** (`space-y-px` — the file tree, the markdown reading view's
  Contents panel). Both states paint a full-width rounded rectangle, so flush rows
  meet edge to edge and a hovered row beside the active one reads as one selected
  block rather than two.

## Verify

```bash
npm run typecheck && npm run build && npm --prefix app run test
cd ideate-mcp && go vet ./... && go test -race ./...
```

`typecheck` now covers one program (the Next app); the Go module is checked by its
own toolchain. `npm --prefix app run test` is the frame-fixture guard and nothing
else — it is the only vitest file in the repo, and it exists because the compiler
no longer keeps the two ends of the wire in agreement.

**Agent Link's behaviour is not reachable by any of that**, and this is where the
bugs actually are. Four real ones have been found only by driving it: the
lost-every-second-edit race, diagnostics reporting on the pre-edit document, the Go
SDK's own 4MiB body limit silently overriding `MAX_BODY_BYTES`, and a close code
that could never reach the tab because cancelling a read tears the socket down
before the close frame goes out. So drive it, end to end, in `?mode=local` with no
repo connected:

```bash
npm run mcp:dev                                                     # :7391
NEXT_PUBLIC_MCP_ORIGIN=http://localhost:7391 npm run dev
claude mcp add --transport http ideate-local http://localhost:7391/mcp
```

Switch Agent Link on, read the code, `ideate_connect` with it, write a *broken*
diagram and confirm **the renderer's diagnostics come back in the tool result** —
that loop is the whole reason the feature exists. Then walk the matrix, none of
which typechecking can see:

- wrong code → refused; repeated wrong codes trip the limiter
- **two tabs, switching between them mid-session by naming the other code** — the
  requirement this design exists to serve
- Regenerate → the old code stops working, the new one works, no reconfiguration
- agent restart → same code still works, no re-pair
- service restart → both sides reconnect, one re-pair
- tab reload → rejoins inside `TAB_GRACE`, agent keeps its attachment
- kill the agent → the attachment idles out and the toolbar stops claiming an agent
  can edit
- `MAX_WS_SESSIONS=1`, then a second tab → 4005, the modal shows the capacity copy
  with a working Retry, and `/v1/capacity` returns 529
- **edits sent faster than React commits** — chain each edit's anchor on what the
  previous one produced, so a dropped edit makes the *next* one fail loudly rather
  than quietly ending up short
- **Safari**, which is the reason for the break
- a `.excalidraw` scene through the scene tools, and a markdown document with a
  broken ```mermaid fence

Excalidraw chrome that only appears in a particular state is easy to get wrong from
a CSS grep alone (both the main-menu and bottom-bar selectors were wrong on the first
attempt). Reproduce the state instead: resize the viewport below ~730px to force the
mobile layout, and toggle `canvas-host--view-mode` on the live host element from the
console to test view-mode rules — neither needs a connected repo, so both are
reachable in `?mode=local`.

`build` and `dev` both run `vendor:excalidraw` first, and it also runs on
`postinstall`, so `public/excalidraw-assets/` is always present and current. It's
gitignored — never commit it, and don't hand-edit it.

Live GitHub read/write flows require a registered GitHub App and a signed-in user
(see README). Most read-action Octokit shapes were validated against the real
GitHub API during development; the two installation endpoints used by
`listRepos()` and the refresh-token exchange in `auth.ts` were written from the
REST docs and are **not yet verified against live GitHub**.
