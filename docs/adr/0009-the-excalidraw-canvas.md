# 0009. Code-splitting, semantic dirty-tracking, and the dark-mode filter

**Status** accepted &nbsp;·&nbsp; **Touches** `app/components/Canvas.tsx, app/components/CanvasInner.tsx, app/lib/excalidraw.ts`

The invariants this record justifies are listed in [`CLAUDE.md`](../../CLAUDE.md). This file holds the reasoning behind them — read it before changing any of them, and update it here when a decision actually changes.

---

## Rule 8

**Excalidraw must stay code-split.** The editor bundle is ~1MB plus ~13MB of
lazily-fetched fonts, and mermaid-only users must never pay for it. It is
reachable through exactly two doors: `components/Canvas.tsx`'s
`dynamic(..., { ssr: false })` (which loads `CanvasInner.tsx`, the only module
allowed to import the component and its CSS) and `lib/exportScene.ts`'s
per-function `await import(...)`. **`lib/excalidraw.ts` must never
*value*-import `@excalidraw/excalidraw`** — type-only imports are erased and so
are fine — because `AppShell` loads it eagerly. Same reason `ExportMenu` may
only reach the library via `lib/exportScene.ts`.

## Rule 9

**Scene dirty-tracking is semantic, never byte-for-byte.** Re-serializing a
scene that was just loaded legitimately changes the bytes (key order, `source`
rewritten to whichever app wrote it, appState renarrowed), so `text !== baseline`
would report every freshly opened file as unsaved. `scenesEqual` /
`sceneSignature` (`lib/excalidraw.ts`) compare the drawing instead, ignoring the
per-element `version`/`versionNonce`/`updated` churn. `AppShell`'s `dirty` and
`openFile`'s draft-restore check both branch on kind for this.

## Rule 10

**The canvas background is chrome, not document content.** It paints the active
 theme's background, but `viewBackgroundColor` is one of the four appState keys
 Excalidraw *does* persist — so serializing what's displayed would rewrite the
 field on every theme change and turn every scene in the repo dirty.
 `CanvasInner.tsx` keeps the file's own value in `storedBackgroundRef` and
 substitutes it back on the way out. Do not persist the displayed color.

## Rule 11

**Excalidraw renders dark mode as a CSS filter on `canvas`**
 (`invert(93%) hue-rotate(180deg)`), which inverts *anything painted into the
 canvas* — backgrounds included. So any color that must come out exact has to
 live outside the canvas: behind it (the host element, for display) or
 composited around it (for export). Never hand Excalidraw a background color and
 expect it back.

## The canvas follows the same palette

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
