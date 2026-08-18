# CLAUDE.md

Guidance for working in this repository.

## What this is

A diagram editor that uses **the user's GitHub repo as the database** — there is
no app database. localStorage holds the uncommitted working copy; GitHub holds the
committed state, on whichever branch is currently selected. Save = commit; open
old version = checkout.

Two kinds of document, decided purely by file extension (`fileKind` in
`lib/tree.ts`):

- **Mermaid** (`.md` / `.mmd` / `.mermaid`) — text, edited in CodeMirror beside a
  live rendered preview.
- **Excalidraw** (`.excalidraw`) — a JSON scene, edited on a full-bleed canvas.

Both are plain text on disk, which is why they share *every* GitHub path
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
   (selected repo, active theme, export prefs, scratch-document kind). Never
   tokens/secrets.
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
12. **Token refresh happens in `proxy.ts` and nowhere else.** GitHub App user
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

With a file open, its extension picks the editing surface. With nothing open —
local mode, or before picking a file — there is no extension to read, so the user
chooses via a Diagram/Canvas toggle backed by `AppConfig.scratchKind`. **Each kind
gets its own localStorage draft slot** (`SCRATCH_DOC_ID` /
`SCRATCH_SCENE_DOC_ID`), so toggling parks the current work instead of overwriting
it with incompatible content. Anything that forces mermaid content into the scratch
doc (`showRepoStartState`, `resetForRepoSwitch`, `detachEditor`) also resets
`scratchKind` to `'mermaid'`.

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
  ahead of expiry (`REFRESH_SKEW_SECONDS`) in `proxy.ts` (rule 12). Session
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
  globals.css               shadcn tokens, @theme inline, minimal custom CSS;
                            also maps the palette onto Excalidraw's own CSS vars
                            and hides its main menu (see "Rendering & theming")
  api/auth/[...nextauth]/    Auth.js route handlers
  actions/{auth,github}.ts  server actions (github.ts = ALL GitHub I/O)
components/
  ui/                       shadcn components (incl. skeleton.tsx, used by the
                            file tree / repo list / commit list loading states)
  AppShell.tsx              orchestrator; collapsible sidebar; controlled modals
  Canvas.tsx                dynamic-import shim: ssr:false + sets
                            window.EXCALIDRAW_ASSET_PATH before the chunk loads
  CanvasInner.tsx           the real Excalidraw editor — the ONLY module that may
                            import the library's component/CSS (rule 8)
  NewFileMenu.tsx           mermaid-vs-canvas picker, shared by the sidebar's root
                            "+" and every folder's "+"
  Editor, Preview, Landing, ExportMenu, RepoPicker, BranchPicker, FileTree,
  ConflictModal, ConfigModal, DeleteModal, PromptModal, HistoryPanel,
  AuthButton, icons.tsx     (icons.tsx also ships the Mermaid + Excalidraw brand
                            marks, taken from each project's own favicon)
lib/
  session.server.ts         server-only token reader (import 'server-only');
                            PURE reader — no refresh, no cookie writes
  mermaid.ts                official-mermaid init + async render (renderToSvg / renderPreview)
  mermaidConfig.ts          global YAML config: parse, layout/theme YAML editing,
                            applyThemeToSite; also resolveThemeMode /
                            themeBackgroundColor / isDarkColor (the color math the
                            canvas + scene export read)
  excalidraw.ts             scene parse + semantic comparison (rule 9). NO value
                            imports from @excalidraw/excalidraw (rule 8)
  exportScene.ts            scene SVG/PNG/JSON export; loads the library lazily
  themes.ts                 preset theme palettes (THEME_PRESETS) for the theme dropdown
  export.ts                 standalone SVG + SVG/PNG download & copy; owns
                            rasterScale(), shared with the scene exporter
  config.ts                 app name / repo URL / commit sha / GitHub App slug
  tree.ts, storage.ts, hooks.ts, types.ts
scripts/
  vendor-excalidraw-assets.mjs
                            copies Excalidraw's fonts into public/ on install and
                            build so nothing is fetched from a CDN at runtime.
                            Output is gitignored and regenerated
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

`CanvasInner.tsx` also imposes `exportScale: 3` (Excalidraw's own maximum) so its
built-in right-click "Copy as PNG" isn't left at the display's `devicePixelRatio`,
and re-frames the scene with `scrollToContent` on mount — scroll/zoom are
deliberately *not* persisted (panning must not dirty a file), so a reopened scene
would otherwise land at the canvas origin.

## Export

mermaid bakes literal colors and a self-contained `<style>` block into the SVG at
render time, so the markup already stands alone — `lib/export.ts` only normalizes
dimensions (mermaid emits `width="100%"` + a viewBox), adds XML namespaces, and
optionally paints a background (white/black/the active theme's own background
color). Both exporters (SVG / PNG) share the single `resolveStandaloneSvg` step;
PNG rasterizes it via `Image` → `<canvas>`. Exporting the mermaid source
(`exportSource`/`copySource`) bakes the global YAML config in as a real
frontmatter block via `buildExportSource`, so the `.mmd` file stands alone too.

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
- **`refreshTree` never blanks the list.** Discarding the stale list is the caller's
  decision, and only the first load and a repo/branch switch
  (`resetForRepoSwitch`) want it; the incidental refreshes after a
  commit/delete/rename keep the list up and swap it when data arrives. A refresh
  that *fails* while a list is on screen shows an inline banner and keeps the list.
  `treeLoading` is tracked separately from `tree === null` for exactly this reason.
- Loading states for lists use `components/ui/skeleton.tsx` with per-call-site
  geometry that mirrors the real rows (indent, padding, line count), so content
  doesn't jump when it swaps in.

## Verify

```bash
npm run typecheck && npm run build
```

`build` and `dev` both run `vendor:excalidraw` first, and it also runs on
`postinstall`, so `public/excalidraw-assets/` is always present and current. It's
gitignored — never commit it, and don't hand-edit it.

Live GitHub read/write flows require a registered GitHub App and a signed-in user
(see README). Most read-action Octokit shapes were validated against the real
GitHub API during development; the two installation endpoints used by
`listRepos()` and the refresh-token exchange in `auth.ts` were written from the
REST docs and are **not yet verified against live GitHub**.
