# CLAUDE.md

Guidance for working in this repository.

## What this is

A Mermaid diagram editor that uses **the user's GitHub repo as the database** —
there is no app database. localStorage holds the uncommitted working copy;
GitHub `main` holds the committed state. Save = commit; open old version =
checkout.

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
4. **Push directly to `main`. No branching, ever.** The branch is the constant
   `MAIN_BRANCH` in `app/actions/github.ts`. No branch selector.
5. **The editor and preview are client components** (`'use client'`). Do not SSR
   them.
6. **Never expose a true force-push.** "Overwrite" on conflict = refetch the
   latest sha, then commit on top of it (`onOverwrite` in `AppShell.tsx`). Do not
   use the git data API to rewrite refs.
7. **MVP renders only the diagram types beautiful-mermaid supports** (flowchart,
   state, sequence, class, ER, XY chart). No core-`mermaid.js` fallback.

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
  Editor, Preview, Landing, ThemeSelect, ExportMenu, RepoPicker, FileTree,
  ConflictModal, PromptModal, HistoryPanel, AuthButton, icons.tsx
lib/
  session.server.ts         server-only token reader (import 'server-only')
  mermaid.ts                render + colorsToCssVars (SVG) + colorsToChromeVars (shadcn tokens)
  export.ts                 shared "resolve theme → standalone SVG" + SVG/PNG/PDF + copy
  color.ts                  sRGB color-mix math (fallback for export inlining)
  themes.ts                 theme registry (built-in + lazy Shiki)
  tree.ts, storage.ts, hooks.ts, types.ts
```

## Theme bridge (whole-site theming)

The active beautiful-mermaid theme drives the entire UI. `useChromeTheme` (in
`lib/hooks.ts`) writes shadcn design tokens — derived by `colorsToChromeVars` —
onto `document.documentElement` (so portaled dialogs/menus are themed too) and
toggles the `dark` class. IMPORTANT: shadcn's `--accent`/`--muted`/`--border`
tokens share names with beautiful-mermaid's SVG palette, so `colorsToCssVars`
emits every optional SVG role on the preview/export wrapper (value, or `initial`
to force the SVG's own color-mix fallback) — shielding the diagram from chrome
colors leaking in. Also: render the SVG with `--mm-bg`/`--mm-fg` (never `--bg`/
`--fg`) to avoid a self-reference cycle.

## Theming + export (the subtle part)

`beautiful-mermaid` colors elements with CSS custom properties derived through
`color-mix()`. For the **live preview** we render once with the palette pointed
at CSS variables and set those variables on the container — theme switches are a
pure CSS update, no re-render (`Preview.tsx`, `lib/mermaid.ts`).

For **export**, CSS variables and `color-mix` do not travel with a downloaded
file (and svg2pdf understands neither), so `lib/export.ts` mounts the SVG
offscreen with the theme applied, reads each element's browser-**computed** color
via `getComputedStyle`, and inlines the literal value onto the attribute. The JS
`color-mix` reproduction in `lib/color.ts` / `resolveThemeVariables` is a fallback
only. All three exporters share this single resolve step.

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
(see README). Read-action Octokit shapes and the export color-inlining were
validated against the real GitHub API and a headless browser during development.
