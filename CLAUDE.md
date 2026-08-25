# CLAUDE.md

Invariants for this repository. Each rule states *what*; the reasoning lives in
[`docs/adr/`](docs/adr/README.md) and is linked per section. **Read the linked record
before changing the rule it justifies.**

## What this is

A diagram editor that uses **the user's GitHub repo as the database** — there is no app
database. localStorage holds the uncommitted working copy; GitHub holds the committed
state on the selected branch. Save = commit; open old version = checkout.

**Local mode has files of its own**, saved in localStorage under `km:file:`, with drafts
layered over them exactly as they layer over a commit. Same lifecycle, different store:
`docIdForPath` and `readSaved` in `AppShell` are the only two places that ask which one.
Local mode has no history, conflicts, branches or PR — those are git, not files. → [ADR
0001](docs/adr/0001-github-as-the-database.md)

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
3. **localStorage stores only** uncommitted editor drafts, app config, and — in local
   mode — the saved files themselves (`km:file:`). Never tokens/secrets. `writeLocalFile`
   is the one storage function that **reports failure**: a local file has no copy
   anywhere else, so a swallowed quota error would claim work was saved when it was lost.
   Two pieces of Agent Link state belong in **`sessionStorage`**, not `AppConfig` — the
   on/off switch and the pairing code, because config is shared by every tab on the
   origin. `AppConfig.mcpOrigin` is the opposite case and belongs in config.
4. **Every read/write server action takes a caller-supplied `branch`** — there is no fixed
   branch constant. No PR-creation or merge logic of any kind: "Open PR" is a plain
   redirect to GitHub's compare URL.
5. **The editor, preview and canvas are client components** (`'use client'`). Do not SSR them.
6. **Never expose a true force-push.** "Overwrite" on conflict = refetch the latest sha,
   then commit on top of it. Do not use the git data API to rewrite refs.
7. **Diagrams render with the official `mermaid` library** (`lib/mermaid.ts`) on the `base`
   theme, `htmlLabels: false`, `curve: 'basis'`. Rendering is async and browser-only —
   render in an effect, never during SSR.
8. **Excalidraw must stay code-split.** `@excalidraw/excalidraw` is reached **only**
   through `Canvas.tsx`'s `dynamic(..., { ssr: false })` or a per-function `await
   import` — today `lib/exportScene.ts` and `lib/sceneEdit.ts`. **Never a module-scope
   value import**, or every mermaid-only user pays for the ~1MB editor. (The rule is
   the import form, not the number of sites: the count was "exactly two doors" and has
   since grown twice.) **`lib/excalidraw.ts` must never *value*-import the library**
   (type-only imports are fine). `ExportMenu` may only reach it via `lib/exportScene.ts`.
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

Both modes have a file tree, a Save and a Restore; `hasWorkspace` (a repo, or local mode)
gates them, **not** `githubEnabled`. Signed in with no repo picked is the one state with
neither. `repo === null` therefore no longer means "there are no files" — ask about the
workspace.

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
- The canvas takes the *mode* of the active theme (`resolveThemeMode`), and that mode is
  **imposed on every path into the editor** — `initialData` *and* the external-sync
  `updateScene` — never left to the `theme` prop alone: Excalidraw prefers the appState it
  is handed, and `restore` hands back a default light theme. Excalidraw chrome
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
- **A subscription is answered with `tools/list_changed`.** Tools are registered once
  at boot, so nothing else ever tells a client that reconnected after a deploy that
  its cached tool list is stale — a client subscribing is the only observable that
  says somebody may hold an older one. Keep `tools.Capabilities` stating
  `listChanged` rather than letting the SDK infer it, keep the pulse coalesced *and*
  capped (never firing is the failure mode that looks like the bug), and keep
  `ideate_status`'s `service.tools` exactly what `tools/list` serves — it is the only
  recourse for a client that never subscribes.
- **`paired` ≠ `attached`.** A paired tab is parked as *waiting*; every command that
  touches the document is refused until `ideate_connect`. `ideate_status` is the one tool
  allowed through unattached, and it returns metadata only — never content.
- **`full` is its own state, not a flavour of `blocked`** — it stops the automatic loop and
  waits for an explicit Retry.
- **The `code` is a tool argument, not a header** — keep the last clause of its
  description. MCP runs **stateless**; attachment therefore needs an idle timeout.
- **A grace-window rejoin must re-send `attached`.**
- **Every document tool takes a `path`, and the mutating ones require it.** `read`,
  `check` and `scene_get` may omit it and mean the open document. `edit`, `write` and
  `scene_edit` must name a file whenever one is open (`requirePath`), because the human
  keeps browsing while the agent works — the exemption is the *untitled* document, which
  has no path to name. A path that matches no file is **created**, and `edit` resolves its
  anchors before creating anything so a failed anchor creates nothing.
- **The theme is not in the document, so the agent is told it** (`BridgeState.theme`). A
  mermaid theme is injected at render time and the file keeps bare fences, so colors
  written into a diagram outlive every theme the human picks — the tool descriptions say
  so, and must keep saying so. A **scene is the opposite**: it stores its own colors and
  has no theme layer, so `scene_get` reports them for matching, and both ends tell the
  agent to author *light* values whatever the mode is, because dark mode is a filter
  (rule 11) that inverts a dark color into a light one.
- **`scene_edit` also aligns and distributes, and moving anything re-routes what is
  bound to it.** `align`/`distribute` exist because their absence is what `misaligned`
  was reporting — the agent's coordinates are stale and its widths were decided by a
  text measurement it never saw. They route through `translate`/`rerouteBoundArrows`
  in `lib/sceneEdit.ts`, and **so does a plain `update` with an x/y**: a bound label
  carries absolute coordinates and a bound arrow's geometry is recorded rather than
  derived, so a box moved by writing the file leaves both behind. Re-route **once, at
  the end of the call**, and **never a multi-point arrow** — that route was somebody's
  choice and `routeBetween` only draws straight lines.
- **`scene_render` is deliberately a bad picture.** 768px, WebP, opaque, no knobs —
  every byte crosses the shared relay and then the agent's context, and a render that
  is too expensive to call after every edit is one that does not get called. Layout is
  what it is for; `scene_get` is for the text. The tab caps the payload itself
  (`SCENE_RENDER_MAX_BYTES`) rather than letting `MAX_FRAME_BYTES` close the socket,
  and the service strips the base64 out of the text block beside the image.
- **`create_canvas` opens what it makes; `scene_edit` deliberately does not.** That is the
  only reason it is a separate tool — `scene_edit` creates a missing path too, but it
  exists to leave the human's editor alone. Both validate ops before writing anything.
  **The two creating tools partition the extensions**: `create_file` takes `.mmd`/`.md`
  and **refuses `.excalidraw`** (its `content` would be raw scene JSON, and omitting it
  opens an empty canvas), `create_canvas` takes only `.excalidraw`. Both refusals live on
  **both sides** and each names the other tool.
- **A scene edit must not need a canvas on screen.** Only a mounted editor registers
  Excalidraw's fonts, and text measured without them sizes every box for a face ~20% too
  narrow — so `lib/excalidrawFonts.ts` registers them itself **at page load**, from a
  manifest `scripts/vendor-excalidraw-assets.mjs` lifts out of the bundle at build time.
  Never make that registration conditional on the open document being a canvas: the tool
  this serves is aimed at files nobody is looking at. It is **not** a third rule-8 door —
  it imports nothing from the library. The extractor asserts everything it assumes and
  **fails the build** on an upstream shape change; do not silence it, and keep Xiaolai
  (209 CJK faces, ~40KB gz) in its own on-demand manifest.
- **Every scene tool answers with `warnings`** — `scene_get`, `scene_edit`,
  `create_canvas` and `scene_render` alike (`lib/sceneLint.ts`) — a canvas has no
  parser to refuse it and no layout engine, so `scene_edit` makes the agent the layout
  engine and this is the only feedback it gets. **Findings are never errors**, they carry
  ids and numbers, they cover the whole scene rather than the diff, and they are capped.
  The field is **always present, empty when clean** — that is what let it ship without a
  `PROTOCOL_VERSION` bump, so keep sending `[]`. `awaitTextFonts` reporting failure is one
  of the kinds (`font_unavailable`); a silently mis-measured box was the original bug.
- **A background edit writes a draft and lights the sidebar's dirty dot** (`writeBack`),
  and clears both when an edit restores the saved content. Nothing about this reaches
  GitHub — rule 13 is intact.
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
  everything downstream sees the outgoing document for a full delay window. It holds the
  key and the value as **one** `{key, value}` snapshot and answers a switch with a
  comparison on the way out. **Do not go back to adjusting two `useState`s from the render
  body**: that returns the outgoing value on the pass that adopts the new key, and React
  commits that pass rather than discarding it — a freshly mounted mermaid preview then
  renders the markdown document it replaced and paints a parse error.
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
