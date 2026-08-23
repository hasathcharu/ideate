# 0013. Two programs in one repo, and the non-obvious file facts

**Status** accepted &nbsp;·&nbsp; **Touches** `package.json, app/, ideate-mcp/`

The invariants this record justifies are listed in [`CLAUDE.md`](../../CLAUDE.md). This file holds the reasoning behind them — read it before changing any of them, and update it here when a decision actually changes.

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
