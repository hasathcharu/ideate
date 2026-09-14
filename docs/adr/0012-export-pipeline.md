# 0012. Export: standalone SVG, size-aware PNG, and scene exporters

**Status** accepted &nbsp;·&nbsp; **Touches** `app/lib/export.ts, app/lib/exportScene.ts, app/components/ExportMenu.tsx`

[`AGENTS.md`](../../AGENTS.md) states repository-wide boundaries and required reading. This record defines the detailed subsystem contracts and their reasoning. Read it before modifying this subsystem, and update it when a decision changes.

---

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

### PNG resolution is a spec, resolved against the drawing

PNG density comes from `resolvePngScale(spec, width, height)` (`lib/export.ts`),
shared by both exporters so the two kinds never differ in what a given setting
means. `rasterScale` is still there, but as the **`auto`** branch rather than the
whole answer: it is size-aware on purpose, because a flat device-pixel multiplier
makes output density proportional to the *diagram*, so a small diagram lands in a
small image — which is what reads as a low-quality export. Auto scales toward a
2400px long edge with a 3× floor for big diagrams, and stays the default.

The other modes exist because "as good as we can make it" is not what someone
exporting for print or for a fixed slot needs. `AppConfig.pngScale` is a
`PngScale` — `auto`, a flat `multiplier` (1×/2×/3×), a `dpi`, or an exact `width`
or `height` in pixels — and **every one of them resolves to a multiplier at export
time, never before**: a DPI, a target width and a target height are all ratios
against a natural size that does not exist until the diagram has rendered. That is
why this is a spec and not a number, and why the resolution happens inside the
render path rather than in the menu.

**Width and height are exclusive, not a pair.** The drawing's aspect ratio already
fixes whichever one is not given, so a second field could only ever be ignored or
be a contradiction — hence one axis chosen from a segmented control, with the
other reported in the hint underneath.

The hard 8192px-per-side cap (`MAX_RASTER_DIMENSION`) applies to **every** mode, `auto` included. Browsers
refuse to allocate a canvas past a few thousand pixels a side and fail outright
rather than degrading, so an over-large request has to come back as a smaller
image: the difference between typing 40000 and getting a big PNG, and typing it
and getting an error toast.

The control lives **under the PNG row**, not beside the shared Background
swatches. Scope is position: next to Background it read as another global setting
and silently exempted the SVG row above it.

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
