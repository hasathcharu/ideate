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
  beside rendered HTML. Any ```mermaid fence inside it renders as a themed
  diagram (`lib/markdown.ts`).
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
`applyThemeToSite` like the rest of the chrome. markdown-it runs with
`html: false` — raw HTML in the source is escaped, not passed through, which is
what keeps this safe without a separate sanitizer; the only markup reaching the
DOM is markdown-it's own output plus mermaid's SVG. Diagrams render
**sequentially**, not through `Promise.all`: mermaid re-`initialize()`s one global
instance and measures against the live DOM, so overlapping renders are a race with
nothing to gain.

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

## Verify

```bash
npm run typecheck && npm run build
```

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
