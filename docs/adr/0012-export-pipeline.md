# 0012. Export: standalone SVG, size-aware PNG, and scene exporters

**Status** accepted &nbsp;·&nbsp; **Touches** `app/lib/export.ts, app/lib/exportScene.ts, app/components/ExportMenu.tsx`

[`AGENTS.md`](../../AGENTS.md) states repository-wide boundaries and required reading. This record defines the detailed subsystem contracts and their reasoning. Read it before modifying this subsystem, and update it when a decision changes.

---

## Export

mermaid bakes literal colors and a self-contained `<style>` block into the SVG at
render time. `lib/export.ts` normalizes dimensions (mermaid emits `width="100%"`
+ a viewBox), expands the viewBox to include painted content that Mermaid placed
outside it, adds XML namespaces, and optionally paints a background
(white/black/the active theme's own background color). Both exporters (SVG / PNG)
share the single `resolveStandaloneSvg` step;
PNG rasterizes it via `Image` → `<canvas>`. Exporting the mermaid source
(`exportSource`/`copySource`) bakes the global YAML config in as a real
frontmatter block via `buildExportSource`, so the `.mmd` file stands alone too.
The render wrapper serializes configuration, font readiness, rendering, and cleanup;
an export therefore cannot inherit configuration from an overlapping preview.

SVG and PNG rows may also save the generated artifact directly to the selected
repository branch. The path prompt defaults beside the source document and the
write remains an ordinary non-force GitHub commit. SVG uses the text path; PNG crosses
the Server Action boundary as a Blob and is base64-encoded only on the server, so
React does not serialize a large base64 value and binary bytes are never interpreted
as UTF-8. This is separate from opening an image and therefore is not subject to
the viewer's 30 MB limit.

When the chosen export path already exists, the app asks for explicit replacement
confirmation. Confirmation refetches the destination's latest blob SHA and commits
on top of it; it never force-pushes or silently overwrites an unsaved local draft.

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
means. The menu offers 1×, 2×, 3×, and Custom, with 2× as the default. The retained
`rasterScale` helper is only a defensive fallback for an invalid programmatic
request; it is not a user-visible mode.

`AppConfig.pngScale` is a `PngScale` — a flat `multiplier` (1×/2×/3×), a `dpi`, or an exact `width`
or `height` in pixels — and **every one of them resolves to a multiplier at export
time, never before**: a DPI, a target width and a target height are all ratios
against a natural size that does not exist until the diagram has rendered. That is
why this is a spec and not a number, and why the resolution happens inside the
render path rather than in the menu.

**Width and height are exclusive, not a pair.** The drawing's aspect ratio already
fixes whichever one is not given, so a second field could only ever be ignored or
be a contradiction — hence one axis chosen from a segmented control, with the
other reported in the hint underneath.

The hard 8192px-per-side cap (`MAX_RASTER_DIMENSION`) applies to every mode. Browsers
refuse to allocate a canvas past a few thousand pixels a side and fail outright
rather than degrading, so an over-large request has to come back as a smaller
image: the difference between typing 40000 and getting a big PNG, and typing it
and getting an error toast.

The control lives **under the PNG row**, not beside the shared Background
swatches. Scope is position: next to Background it read as another global setting
and silently exempted the SVG row above it.

### SVG theme and the optional frame

Mermaid SVG has two theme modes. **Forced** is a single fixed rendering.
**Dynamic** embeds independently rendered default-light and dark variants and a
small `prefers-color-scheme` media rule, so it remains self-contained while
following the viewer. Known preset families use their exact light/dark counterpart
(for example GitHub Light and GitHub Dark), resolved by `counterpartPreset`. A
custom or unpaired palette falls back to Mermaid's default light/dark pair because
arbitrary literal colors cannot be reliably converted. Excalidraw SVG exposes the
same modes and embeds its native light/dark renderings, using the paired palette
backgrounds when Theme is selected.

**The background decides the palette a fixed rendering uses** —
`configForBackground`, the same rule scenes follow below. Solarized Dark's body text
is `#839496`; painted onto a chosen White background it was very nearly invisible,
and the export was unusable in exactly the case the swatch was picked for. So White
yields dark-on-white and Black light-on-black whatever the editor is set to,
swapping in the active palette's counterpart. **Theme** and transparent keep the
configured palette untouched: one *is* the palette's own surface, and the other has
no surface to judge. A palette already on the right side of that line is left alone,
so this only ever fires on the mismatch. This applies to PNG as well, which has no
theme control of its own and would otherwise have no way out of the same problem.

**A dynamic SVG inverts a plain background for the other scheme** (`dynamicBranches`).
The swatch names the surface a *light-mode* viewer should see, and a dark-mode viewer
gets its opposite: White is white-then-black, Black is black-then-white. Holding the
surface still instead left one branch painting the diagram in its own background
color — White under both variants put the dark branch's light strokes on white.

Within that, **the palette follows the surface, not the media query** its branch is
named after. Pick Black and the light-mode branch is light-on-black (the dark
palette) while the dark-mode branch is dark-on-white (the light palette). Pairing
each branch with the palette its media query is named after would undo the inversion
and reintroduce the same invisible rendering one step along.

**Theme** and transparent need none of this: a theme background already varies per
branch, because each branch carries its own palette's `background`, and transparent
has no surface to invert.

Image exports can add a 24px padded frame with a 16px rounded background. The
same choice reaches SVG, PNG, Mermaid, and Excalidraw paths. Without the option,
Mermaid still expands its export bounds enough to cover overflowed labels; the
frame is presentation, not a workaround for clipping.

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
dark-on-white, "Theme" follows the palette. Mermaid follows the same rule above. Transparent is the one case with no
surface to judge, so it follows the active theme's mode instead — reading the
scene's stored canvas color there would always answer "light", because that value
is the file's own and the displayed background is theme-driven chrome the file never
records (rule 10).
