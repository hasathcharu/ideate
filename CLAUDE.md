# CLAUDE.md

Invariants for this repository. Each rule states *what*; the reasoning lives in
[`docs/adr/`](docs/adr/README.md) and is linked per section. **Read the linked record
before changing the rule it justifies.**

## What this is

A diagram editor that uses **the user's GitHub repo as the database** — there is no app
database. localStorage holds the uncommitted working copy; GitHub holds the committed
state on the selected branch. Save = commit; open old version = checkout.

Three document kinds, decided purely by file extension (`fileKind` in `lib/tree.ts`):
**Mermaid** (`.mmd`/`.mermaid`), **Markdown** (`.md`/`.markdown`), **Excalidraw**
(`.excalidraw`). All three are plain text on disk and share every GitHub path
(read/commit/rename/delete/history/conflicts); only the editing surface and the export
pipeline differ. `.md` is markdown, **not** mermaid. → [ADR 0001](docs/adr/0001-github-as-the-database.md)

## Hard architectural rules (non-negotiable)

1. **All GitHub API calls go through Next.js Server Actions** in `app/actions/github.ts`
   (each `'use server'`). Octokit is server-side only.
2. **The GitHub access token — and the refresh token — never reach the browser.** Never
   add either to the object returned by the `session` callback, to localStorage, or to a
   client-component prop. Read the access token server-side via `getGitHubToken()`.
3. **localStorage stores only** uncommitted editor drafts and app config. Never
   tokens/secrets. Two pieces of Agent Link state belong in **`sessionStorage`**, not
   `AppConfig` — the on/off switch and the pairing code, because config is shared by every
   tab on the origin. `AppConfig.mcpOrigin` is the opposite case and belongs in config.
4. **Every read/write server action takes a caller-supplied `branch`** — there is no fixed
   branch constant. No PR-creation or merge logic of any kind: "Open PR" is a plain
   redirect to GitHub's compare URL.
5. **The editor, preview and canvas are client components** (`'use client'`). Do not SSR them.
6. **Never expose a true force-push.** "Overwrite" on conflict = refetch the latest sha,
   then commit on top of it. Do not use the git data API to rewrite refs.
7. **Diagrams render with the official `mermaid` library** (`lib/mermaid.ts`) on the `base`
   theme, `htmlLabels: false`, `curve: 'basis'`. Rendering is async and browser-only —
   render in an effect, never during SSR.
8. **Excalidraw must stay code-split.** Exactly two doors: `Canvas.tsx`'s
   `dynamic(..., { ssr: false })` and `lib/exportScene.ts`'s per-function `await import`.
   **`lib/excalidraw.ts` must never *value*-import `@excalidraw/excalidraw`** (type-only
   imports are fine). `ExportMenu` may only reach the library via `lib/exportScene.ts`.
9. **Scene dirty-tracking is semantic, never byte-for-byte.** Compare with
   `scenesEqual`/`sceneSignature`, never `text !== baseline`.
10. **The canvas background is chrome, not document content.** Never persist the displayed
    color — `CanvasInner.tsx` keeps the file's own value in `storedBackgroundRef` and
    substitutes it back on the way out.
11. **Excalidraw renders dark mode as a CSS filter on `canvas`**, which inverts anything
    painted into it. Never hand Excalidraw a background color and expect it back —
    composite it outside the canvas (behind it for display, around it for export).
12. **Agent Link: the pairing code is the credential, and TLS is not optional.**
    - The service URL must be `https:`, or `http:` on `localhost`/`127.0.0.1` port 7391 —
      enforced on both sides, one implementation each: `validateMcpOrigin` (`lib/mcpOrigin.ts`)
      and `internal/config.ValidateMCPOrigin`.
    - The code never reaches a URL, a query string, or a log line. Logs carry an
      8-character prefix of the hash at most.
    - Every frame `lib/agentProtocol.ts` declares needs a fixture in
      `ideate-mcp/testdata/frames/`, **added in the same change**.
    - **Add no CORS configuration to the service.**
13. **No agent tool may write to GitHub.** No commit tool; rename and delete are
    deliberately not exposed either, because in this app they *are* commits. An agent's
    blast radius is the uncommitted working copy.
14. **Token refresh happens in `proxy.ts` and nowhere else.** `getGitHubToken()` must stay
    a pure reader, and `auth.ts`'s `jwt` callback refreshes only when its lazy-config
    `request` argument is present — never on an RSC render. Do not add a refresh path
    anywhere else, and do not add a DB/KV lock for it.

Reasoning: [0002](docs/adr/0002-auth-tokens-and-server-actions.md) (1, 2, 14) ·
[0003](docs/adr/0003-branch-model-and-no-force-push.md) (4, 6) ·
[0004](docs/adr/0004-client-state-localstorage-and-per-tab.md) (3) ·
[0007](docs/adr/0007-theming-and-the-contrast-floor.md) (7) ·
[0009](docs/adr/0009-the-excalidraw-canvas.md) (8–11) ·
[0011](docs/adr/0011-agent-link.md) (12, 13)

## Auth

A **GitHub App**, not an OAuth App.

- **There is no OAuth scope.** Don't reintroduce a scope option.
- **Authorization ≠ installation.** `listRepos()` returns `{ repos, installationCount }`;
  repos come from `GET /user/installations` + `.../repositories`, **not** `GET /user/repos`.
- **Losing a repo looks like an empty repo** — GitHub answers 404, never 403. `listTree`
  must probe `repos.get` in that error path (`repoAccessLost`) and return
  `kind: 'repo_unavailable'`; only a 404 on the probe counts. Do not clear `config.repo`.
- **A dead session is handled globally, never per-surface.** Every client site that
  branches on an action error calls `handleExpiredSession(error)` (`lib/sessionExpiry.ts`)
  **first** and returns if it answers `true`. Add the guard to any new error site.

→ [ADR 0002](docs/adr/0002-auth-tokens-and-server-actions.md)

## UI stack

Prefer shadcn primitives and Tailwind utilities over bespoke CSS.

## Routing / modes

- `/` — marketing landing. Unauthenticated users pick Local mode (`/editor?mode=local`) or
  GitHub repo mode (sign in → `/editor`).
- `/editor` — the app. Signed-in → `mode="github"`; `?mode=local` without a session →
  `mode="local"`; otherwise redirect to `/`.

With nothing open, the Diagram/Markdown/Canvas toggle picks the surface via
`AppConfig.scratchKind`. **Each kind gets its own localStorage draft slot** — route every
scratch-slot lookup through `scratchDocIdFor`, never re-derive it. Anything that forces
mermaid content into the scratch doc also resets `scratchKind` to `'mermaid'`. Markdown is
listed first in `NewFileMenu` and in the toggle.

- **Creating a file: only the name is typed.** `PromptModal` shows folder and extension as
  uneditable `prefix`/`suffix`. **Rename is deliberately different** — a single free-text
  path field, because moving a file between folders is the point of it.
- **Renaming a never-committed file is local only** — move the draft slot, skip the API
  call and the tree refresh. A *committed* path still lands on GitHub **first**.
- **`pendingPaths` is a set, not the open file.** It outlives the file being open;
  creating a file writes its draft immediately; a commit hands the path straight to the
  tree (`treeWithPath`) and records it **committed**, not pending; `confirmDelete` clears
  the drafts of everything it deletes. Draft recovery runs **once per repo/branch**.
- **Selecting a repository is a precondition**, so `AppShell` opens `RepoPicker`
  automatically once per mount (ref-guarded). A fresh sign-in always clears the stored
  repo via `?connect=1`, and the flag must be stripped with `history.replaceState`.

→ [ADR 0006](docs/adr/0006-file-lifecycle-and-routing.md)

## The text editor

One CodeMirror instance for both text kinds; swap per-document settings through a
`Compartment`, **never by remounting**.

- **It does not use `basicSetup`** — `baseSetup` spells it out. Keep `autocompletion()`
  appearing **exactly once** (markdown link-target completions are registered as language
  data and must reach it), configured `{ icons: false }`, with `detail` set only when it
  differs from the label.
- **Keep the gutter order: line numbers → changes → folds.** `foldGutter` is added at the
  mount site, after the dirty gutter.
- **Every surface CodeMirror paints itself must be named in `editorTheme`** — including
  `.cm-searchMatch`, `.cm-selectionMatch` and `.cm-tooltip`.
- **`dark` must be the palette's real mode** (`resolveThemeMode`), never a constant.
- **Translucent accents blend into `--background`**, not into transparency.
- The viewfinder (`Minimap.tsx`) **is a canvas**, at a **fixed 3px per line** with the map
  sliding on scroll *progress* (add `mapTop` back when mapping pointer → document), and
  reads its colors from computed style at draw time. Scroll geometry comes from
  `scrollDOM`, and the first measurement is synchronous.
- **Double-click line sync is imperative, not a prop** — a `revealLine` on each side's
  handle. Line numbers come from markdown-it's own `map`; never re-derive them by counting
  rendered elements. Splitting is legal only at `token.level === 0`.

→ [ADR 0005](docs/adr/0005-the-text-editor.md) · [ADR 0008](docs/adr/0008-markdown-rendering.md)

## Rendering & theming

A single global mermaid config, raw YAML in `AppConfig.mermaidConfig`, is the source of
truth for `theme`/`themeVariables` and `layout`. The Theme and Layout dropdowns write into
that same YAML via `setThemeInYaml`/`setLayoutInYaml` rather than owning separate state.

- **Every theme token that ends up holding words goes through `ensureContrast`** against
  the surface it is actually painted on (AA 4.5:1 for text, 3:1 for `--ring`). A passing
  color is returned untouched; the lift blends toward white or black, never another hue.
  **`--border`/`--input` are deliberately excluded.**
- **The config is injected at render time and never written into the document** — the file
  in the repo holds bare ```mermaid fences. Only "Markdown + Theme" export bakes it in.
- **Do not portal a viewport into a node `innerHTML` created.** `renderMarkdown` returns
  `MarkdownPart[]` so React owns every diagram outright.
- **A maximized viewport must be opaque**; the fallback is white, not `var(--background)`.
- **Sanitize order is render → sanitize → substitute**, never any other order. Placeholders
  are elements (the sanitizer strips comments); the top-level mermaid split marker is a
  comment. `sanitizeHtml` returns `''` with no DOM — that is a caller bug, and failing
  closed is the only safe answer.
- **`scrollbar-color` must be declared on `*`** (it is inherited and resolves where
  declared). **Standard properties only**, with `::-webkit-scrollbar` behind
  `@supports not (scrollbar-color: auto)`. **`color-scheme` goes on `<html>`**, not `<body>`.
- The canvas takes the *mode* of the active theme (`resolveThemeMode`). Excalidraw chrome
  rules in `globals.css` are prefixed `body ` on purpose (specificity). The main-menu
  selector is `.main-menu-trigger` — **not** `dropdown-menu-button` or its `data-testid`.
  View-mode rules must stay scoped to view mode.

→ [ADR 0007](docs/adr/0007-theming-and-the-contrast-floor.md) ·
[ADR 0008](docs/adr/0008-markdown-rendering.md) ·
[ADR 0009](docs/adr/0009-the-excalidraw-canvas.md)

## Uncommitted changes are shown as a diff

`lib/diff.ts` is a Myers line diff with a prefix/suffix trim and a `MAX_DIFF_LINES` cap.
**No GitHub call is involved** — the app already holds `baseline`. It feeds the editor's
dirty gutter, the peek popup (whose Revert reduces every change to one `LineChangeRevert`
and dispatches it so ⌘Z undoes it), and `DiffView.tsx`.

- The gutter is **empty when `loadedSha === null`**.
- The change map is pushed into CodeMirror as a `StateEffect` — the baseline is the app's
  state, not the editor's.
- **Scenes are excluded everywhere** — a `.excalidraw` line diff shows changes that aren't
  there (rule 9).
- In version history, only claim a file was created in a commit when there is genuinely
  nothing more to page in.

→ [ADR 0010](docs/adr/0010-diff-and-the-dirty-gutter.md)

## Agent Link

An MCP server (`ideate-mcp/`, Go) that hands a coding agent **the document open in the
browser right now**. Rules 12 and 13 above are the non-negotiable part.

- **Ship both ends of a `PROTOCOL_VERSION` bump together.** The two sides refuse to talk
  on a mismatch (`CLOSE_PROTOCOL_MISMATCH`), and there is no longer a beta label warning
  users to expect it.
- **`paired` ≠ `attached`.** A paired tab is parked as *waiting*; every command that
  touches the document is refused until `ideate_connect`. `ideate_status` is the one tool
  allowed through unattached, and it returns metadata only — never content.
- **`full` is its own state, not a flavour of `blocked`** — it stops the automatic loop and
  waits for an explicit Retry.
- **The `code` is a tool argument, not a header** — keep the last clause of its
  description. MCP runs **stateless**; attachment therefore needs an idle timeout.
- **A grace-window rejoin must re-send `attached`.**
- **`emittedRef` is the echo guard** — the editor keeps a short history of what it emitted
  and drops an incoming value it finds there. **Do not collapse this into a single
  `lastValue` ref.**
- **Diagnostics run on the text the edit *produced*** (`applyEdits` returns it), never on
  state read back.
- `lib/sceneEdit.ts` returns scene *text*, never a canvas ref, and must route arrows itself
  (`convertToExcalidrawElements` binds but does not route). **Nothing that holds text may be
  measured before its font is loaded** — `applySceneOps` awaits `awaitTextFonts` first, and a
  text change re-measures its box via `refit`.
- **Known, unfixed:** `ideate_write` immediately followed by `ideate_edit` can race.

Setup: `claude mcp add --transport http ideate https://<service>/mcp` (once — after that
the pairing code is the only thing that changes). Locally: `npm run mcp:dev` on :7391.
Published as `docker.io/hasathcharu/ideate-mcp`.

→ [ADR 0011](docs/adr/0011-agent-link.md)

## Export

`lib/export.ts` normalizes mermaid's SVG (dimensions, XML namespaces, optional background)
through a single `resolveStandaloneSvg`; PNG rasterizes it. PNG resolution comes from
`rasterScale(width, height)`, shared by both exporters.

- **Markdown exports its source verbatim** — no render step, no image format, and
  deliberately **no theme-baking variant**.
- **Scenes export through Excalidraw's own exporters** (`lib/exportScene.ts`), with
  `exportBackground: false` — **we always composite the background ourselves** (rule 11).
- **Set both `appState.exportWithDarkMode` and `appState.theme`**, or SVG and PNG disagree.

→ [ADR 0012](docs/adr/0012-export-pipeline.md)

## Repository layout

Two programs, two languages, one repo: the Next.js app in `app/`, the Go MCP service in
`ideate-mcp/`. **`app/app/` is not a typo** — the package directory and Next's router
directory share a name.

There are **no npm workspaces**: the root `package.json` holds no dependencies and
delegates with `npm --prefix app`; its `postinstall` runs the app's install. `.env.local`
lives in `app/`, because that is Next's working directory.

→ [ADR 0013](docs/adr/0013-repository-layout-and-file-map.md) for the file-by-file map.

## Conventions

- TypeScript strict; server actions return `ActionResult<T>` so the client can branch on
  errors (`kind: 'conflict'`, `kind: 'unauthenticated'`) without try/catch.
- Keep server-only code out of client bundles; `lib/session.server.ts` imports `server-only`.
- **`useDebouncedValue` must stay keyed on the open document** (`docId`) — unkeyed,
  everything downstream sees the outgoing document for a full delay window.
- **The draft is written only while the document is dirty**, and cleared the moment it
  isn't. Keep the `dirty` gate on any new autosave path.
- **`refreshTree` never blanks the list.** Only the first load and a repo/branch switch
  discard it; a failed refresh shows an inline banner and keeps the list. `treeLoading` is
  tracked separately from `tree === null`.
- Loading states use `components/ui/skeleton.tsx` with per-call-site geometry mirroring the
  real rows.
- **A list whose rows have both a hover fill and an active tint needs `space-y-px`.**

→ [ADR 0014](docs/adr/0014-conventions.md)

## Verify

```bash
npm run typecheck && npm run build && npm --prefix app run test
cd ideate-mcp && go vet ./... && go test -race ./...
```

`npm --prefix app run test` is the frame-fixture guard and nothing else — the only vitest
file in the repo, and it exists because the compiler no longer keeps the two ends of the
wire in agreement.

**Agent Link's behaviour is not reachable by any of that**, and it is where the bugs
actually are. Drive it end to end and walk the matrix in
[ADR 0011](docs/adr/0011-agent-link.md#verifying-it--not-reachable-by-typecheck-or-build).

Excalidraw chrome that only appears in a particular state is easy to get wrong from a CSS
grep alone: reproduce the state instead — resize below ~730px for the mobile layout, and
toggle `canvas-host--view-mode` on the live host element from the console. Both are
reachable in `?mode=local`.

`build` and `dev` both run `vendor:excalidraw` first, and it also runs on `postinstall`, so
`public/excalidraw-assets/` is always present. It's gitignored — never commit it, and don't
hand-edit it.

Live GitHub read/write flows require a registered GitHub App and a signed-in user (see
README). The two installation endpoints used by `listRepos()` and the refresh-token
exchange in `auth.ts` were written from the REST docs and are **not yet verified against
live GitHub**.
