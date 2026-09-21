# 0013. Two programs in one repo, and the non-obvious file facts

**Status** accepted &nbsp;·&nbsp; **Touches** `package.json, app/, ideate-mcp/`

[`AGENTS.md`](../../AGENTS.md) states repository-wide boundaries and required reading. This record defines the detailed subsystem contracts and their reasoning. Read it before modifying this subsystem, and update it when a decision changes.

---

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

- `proxy.ts` — Next 16 request hook;
  `export { auth as proxy }`. Never redirects; local mode passes straight through.
- `components/Canvas.tsx` — sets `window.EXCALIDRAW_ASSET_PATH` *before* the
  lazy chunk loads; ordering matters.
- `components/AppShell.tsx` — workspace/document orchestration. Page chrome is
  split across `AppLayout`, `AppHeader`, `WorkspaceSidebar`, `DocumentToolbar`,
  `DocumentSurface`, and `AppDialogs`; `useHistoryController` owns version-history
  request state. `useAgentLinkController`, `useWorkspaceTree`,
  `useAppearanceController`, and `useResizableLayout` own their corresponding
  integration/derived-state concerns. Presentation modules receive state and intent
  callbacks and do not access durable storage directly.
- `components/icons.tsx` — ships the Mermaid, Markdown and Excalidraw brand
  marks taken from each project's own favicon, normalized to bare filled glyphs
  in `currentColor`: no badge, no brand hue, so the three read as one family and
  follow the active theme.
- `app/actions/github.ts` — repository API operations. Authentication and token
  exchange use `auth.ts`.
- `lib/highlight.ts` — the only module that touches shiki, always through
  `await import`. Type-only imports are erased, so those are fine.
- `lib/diff.ts` — the diff algorithm and nothing else; no React, no I/O.
- `lib/findInDocument.ts` — find-in-page over the rendered markdown: text-node
  flattening, `Range` construction, and the `CSS.highlights` painting. It exists
  as its own module because the one rule that shapes it — never mutate the
  document to decorate it — is easy to lose inside a component.
- `lib/color.ts` — static color arithmetic (parse / luminance / contrast / mix /
  `ensureContrast`). No DOM: it must work on a color *before* it becomes a CSS
  string, which is why `applyThemeToSite` blends numerically instead of emitting
  `color-mix()` for anything it then has to measure.
- `lib/agentProtocol.ts` — Agent Link's wire contract, hand-mirrored in Go. Every frame
  it declares needs a fixture in `ideate-mcp/testdata/frames/`.
- `lib/sceneLint.ts` — the layout checks an agent's drawing is answered with. Pure
  geometry over finished elements: no React, no I/O, and no value import of
  Excalidraw, which is what lets both `applySceneOps` and `summarizeScene` call it.
- `lib/excalidrawFonts.ts` — registers Excalidraw's scene fonts on `document.fonts`
  from the build-time manifest, so measuring text does not need a mounted editor.
  Imports nothing from `@excalidraw/excalidraw`; see rule 8 in
  [ADR 0009](0009-the-excalidraw-canvas.md).
- `scripts/vendor-excalidraw-assets.mjs` — copies the font files into `public/` **and**
  extracts the `@font-face` descriptors that go with them into two manifests. The one
  build step that reads the installed bundle's internals, so every assumption it makes
  is asserted and a shape change fails the build.
  `vendor:excalidraw` runs on build, dev, and postinstall. Its generated
  `app/public/excalidraw-assets/` directory (repository-relative) is gitignored.
  Never commit or hand-edit that directory.
- `lib/mcpOrigin.ts` — the TLS rule for the Agent Link service origin, and the
  `ws://`/`wss://` derivation. Mirrored by `internal/config.ValidateMCPOrigin`,
  whose test carries the same cases.
- `lib/agentFrames.test.ts` — the TypeScript
  half of the cross-language wire guard. Its frames must stay hand-written
  literals: deriving one from the fixture it is compared against would assert that
  a file equals itself.
- `test/fakes.ts` — controlled promises, browser storage, and GitHub API responses
  for deterministic lifecycle tests. The app workflow runs typecheck, build, lint,
  and Vitest on pull requests and pushes to `main`.
- `ideate-mcp/` — a separate Go module, not part of any tsconfig. It logs
  structured JSON to stderr.
- `types/markdown-it-emoji.d.ts` — the plugin ships no types.
