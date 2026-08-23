# 0007. A diagram palette is not a text palette

**Status** accepted &nbsp;·&nbsp; **Touches** `app/lib/color.ts, app/lib/themes.ts, app/lib/mermaidConfig.ts, app/app/globals.css`

The invariants this record justifies are listed in [`CLAUDE.md`](../../CLAUDE.md). This file holds the reasoning behind them — read it before changing any of them, and update it here when a decision actually changes.

---

## Rule 7

**Diagrams render with the official `mermaid` library** (`lib/mermaid.ts`),
on the built-in `base` theme so the global YAML config's `themeVariables` can
retune it. Rendering is async and browser-only. Any diagram type mermaid
supports works.

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


## Native chrome follows it too (scrollbars, `color-scheme`)

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
