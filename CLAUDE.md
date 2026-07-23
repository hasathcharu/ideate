# CLAUDE.md

Guidance for working in this repository.

## What this is

A Mermaid diagram editor that uses **the user's GitHub repo as the database** —
there is no app database. localStorage holds the uncommitted working copy;
GitHub holds the committed state, on whichever branch is currently selected.
Save = commit; open old version = checkout.

## Hard architectural rules (non-negotiable)

1. **All GitHub API calls go through Next.js Server Actions** in
   `app/actions/github.ts` (each `'use server'`). Octokit is server-side only.
2. **The GitHub access token never reaches the browser.** It is persisted into
   the encrypted session JWT in the `jwt` callback (`auth.ts`) and read
   server-side via `getGitHubToken()` (`lib/session.server.ts`). It must **not**
   be added to the object returned by the `session` callback (that object is
   serialized to the client at `/api/auth/session`), nor stored in localStorage,
   nor passed as a client-component prop.
3. **localStorage stores only** uncommitted editor drafts and app config
   (selected repo, active theme, export prefs). Never tokens/secrets.
4. **Every read/write server action takes a caller-supplied `branch`** — there
   is no fixed branch constant. The selected `{owner, name, defaultBranch,
   branch}` (`RepoRef`, `lib/types.ts`) lives in `AppConfig.repo`;
   `BranchPicker.tsx` lists/creates branches (`listBranches`/`createBranch` in
   `app/actions/github.ts`). "Open PR" is a plain redirect to GitHub's compare
   URL (`compare/{defaultBranch}...{branch}`) — there is no PR-creation API
   surface, and no server-side PR/merge logic of any kind.
5. **The editor and preview are client components** (`'use client'`). Do not SSR
   them.
6. **Never expose a true force-push.** "Overwrite" on conflict = refetch the
   latest sha, then commit on top of it (`onOverwrite` in `AppShell.tsx`). Do not
   use the git data API to rewrite refs.
7. **Diagrams render with the official `mermaid` library** (`lib/mermaid.ts`),
   on the built-in `base` theme so the global YAML config's `themeVariables` can
   retune it. Rendering is async and browser-only. Any diagram type mermaid
   supports works.

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

## Layout

```
auth.ts                     NextAuth v5 config; single OAuth scope config point
app/
  layout.tsx                fonts + TooltipProvider + <Toaster/> (sonner)
  page.tsx                  landing; editor/page.tsx gates on auth + mode
  globals.css               shadcn tokens, @theme inline, minimal custom CSS
  api/auth/[...nextauth]/    Auth.js route handlers
  actions/{auth,github}.ts  server actions (github.ts = ALL GitHub I/O)
components/
  ui/                       shadcn components
  AppShell.tsx              orchestrator; collapsible sidebar; controlled modals
  Editor, Preview, Landing, ExportMenu, RepoPicker, BranchPicker, FileTree,
  ConflictModal, ConfigModal, DeleteModal, PromptModal, HistoryPanel,
  AuthButton, icons.tsx
lib/
  session.server.ts         server-only token reader (import 'server-only')
  mermaid.ts                official-mermaid init + async render (renderToSvg / renderPreview)
  mermaidConfig.ts          global YAML config: parse, layout/theme YAML editing, applyThemeToSite
  themes.ts                 preset theme palettes (THEME_PRESETS) for the theme dropdown
  export.ts                 standalone SVG + SVG/PNG download & copy
  config.ts                 app name / repo URL / commit sha constants
  tree.ts, storage.ts, hooks.ts, types.ts
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

## Export

mermaid bakes literal colors and a self-contained `<style>` block into the SVG at
render time, so the markup already stands alone — `lib/export.ts` only normalizes
dimensions (mermaid emits `width="100%"` + a viewBox), adds XML namespaces, and
optionally paints a background (white/black/the active theme's own background
color). Both exporters (SVG / PNG) share the single `resolveStandaloneSvg` step;
PNG rasterizes it via `Image` → `<canvas>`. Exporting the mermaid source
(`exportSource`/`copySource`) bakes the global YAML config in as a real
frontmatter block via `buildExportSource`, so the `.mmd` file stands alone too.

## Conventions

- TypeScript strict; server actions return `ActionResult<T>` so the client can
  branch on errors (especially `kind: 'conflict'` for 409/422) without try/catch.
- Keep server-only code out of client bundles; `lib/session.server.ts` imports
  `server-only` as a guard.

## Verify

```bash
npm run typecheck && npm run build
```

Live GitHub read/write flows require a configured OAuth app and a signed-in user
(see README). Read-action Octokit shapes were validated against the real GitHub
API during development.
