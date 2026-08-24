'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { CaptureUpdateAction, Excalidraw, restore, serializeAsJSON } from '@excalidraw/excalidraw'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import { parseScene, scenesEqual } from '@/lib/excalidraw'
import { cn } from '@/lib/utils'

/**
 * The real Excalidraw editor. Loaded only through `Canvas.tsx`'s dynamic import —
 * never import this module directly, or the ~1MB editor bundle (plus its CSS)
 * lands in the main chunk for users who only ever open mermaid files.
 *
 * The contract deliberately mirrors `Editor.tsx`: `value` is the file's text and
 * `onChange` reports new text. Keeping scenes as a serialized string means every
 * piece of AppShell's plumbing — dirty tracking, localStorage drafts, commit,
 * conflict resolution, history — works on scenes with no special-casing.
 */

/**
 * appState the app imposes on the editor rather than reading from the file.
 *
 * `exportScale` sets the resolution of Excalidraw's *own* export actions — the
 * right-click "Copy to clipboard as PNG", Shift+Alt+C, and the copy-as-PNG entry
 * in the command palette. Its default is the display's `devicePixelRatio`, so on a
 * non-retina screen it silently falls to 1× and the copied bitmap looks soft. 3 is
 * the maximum Excalidraw offers in its own UI (its EXPORT_SCALES is [1, 2, 3]).
 *
 * Safe to force: `exportScale` is one of the keys Excalidraw excludes from
 * `serializeAsJSON`, so overriding it can never dirty a file or reach a commit.
 */
const IMPOSED_APP_STATE = { exportScale: 3 } as const

export interface CanvasInnerProps {
  value: string
  onChange: (value: string) => void
  /** Derived from the active mermaid theme's palette, not chosen here — see
   *  `resolveThemeMode`. Excalidraw's theme is a binary light/dark switch. */
  theme: 'light' | 'dark'
  /** Read-only canvas, used for previewing a historical version. */
  viewMode?: boolean
  /** The active theme's background color, painted *behind* the canvas. See
   *  `displayBackground` for why it isn't handed to Excalidraw directly, and
   *  `storedBackgroundRef` for why it never reaches the file. */
  backgroundColor?: string
}

export default function CanvasInner({
  value,
  onChange,
  theme,
  viewMode = false,
  backgroundColor,
}: CanvasInnerProps) {
  /**
   * Everything in `IMPOSED_APP_STATE`, plus the theme — imposed on *every* path
   * into the editor, mount and external sync alike.
   *
   * The theme has to be spelled out here because `restore` (below) fills a scene
   * out to a *complete* appState, `theme` included, and Excalidraw prefers the
   * appState it is handed over the `theme` prop: `syncActionResult` resolves it as
   * `actionResult.appState.theme || this.props.theme`. A scene file carries no
   * theme of its own, so what `restore` hands back is its default — light. An
   * external edit arriving while a dark palette was active therefore knocked the
   * canvas out of dark mode, and it stayed out until the palette changed or the
   * file was reopened. That is what an agent drawing on a canvas looked like:
   * a scene ignoring the theme around it, fixed by navigating away and back.
   *
   * Safe to impose for the same reason as `exportScale`: `theme` is one of the
   * keys Excalidraw excludes from `serializeAsJSON`, so forcing it can never
   * dirty a file or reach a commit.
   */
  const imposedAppState = useMemo(() => ({ ...IMPOSED_APP_STATE, theme }), [theme])

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // The last text this component either emitted or ingested. Both directions of
  // sync compare against it, which is what breaks the feedback loop: our own
  // `onChange` output comes back down as a new `value` prop, and must not be
  // re-applied to the scene as if it were an external edit.
  const lastTextRef = useRef(value)

  // Parsed once, on mount. Excalidraw only reads `initialData` when it mounts, so
  // recomputing it per render would be wasted work; later `value` changes go
  // through the sync effect below instead.
  const [initialScene] = useState(() => parseScene(value))

  /**
   * The canvas background the *file* declares, kept separate from the one being
   * displayed.
   *
   * The visible background follows the active theme, which makes it chrome rather
   * than document content — but `viewBackgroundColor` is one of the four appState
   * keys Excalidraw *does* persist. Serializing it as-displayed would rewrite the
   * field on every theme change, so every scene in the repo would go dirty the
   * moment the user picked a different palette. So the displayed color is imposed
   * for rendering only, and the file's own value is substituted back on the way
   * out (see `handleChange`).
   */
  const storedBackgroundRef = useRef<string>(
    typeof initialScene?.appState?.viewBackgroundColor === 'string'
      ? initialScene.appState.viewBackgroundColor
      : '#ffffff',
  )

  const [syncError, setSyncError] = useState<string | null>(null)
  const [apiReady, setApiReady] = useState(false)

  const hostRef = useRef<HTMLDivElement | null>(null)
  /**
   * "Maximized" fills the browser window instead of entering real fullscreen. The
   * Fullscreen API hides the browser's own chrome, which is more than is wanted
   * for expanding a pane; a fixed, inset-0 overlay gives the same working area
   * with tabs and the URL bar still visible.
   *
   * Note there's deliberately no Escape binding here, unlike the mermaid preview:
   * Escape is Excalidraw's own shortcut for clearing a selection and cancelling the
   * active tool, so stealing it would break drawing. The toggle stays on screen in
   * maximized mode, so there's always a visible way back.
   */
  const [isMaximized, setIsMaximized] = useState(false)
  const toggleMaximized = useCallback(() => setIsMaximized((v) => !v), [])

  /**
   * What Excalidraw is told to paint as the canvas background.
   *
   * Not the theme color itself — `.excalidraw.theme--dark canvas` carries
   * `filter: invert(93%) hue-rotate(180deg)`, so any color painted *into* the
   * canvas comes back out inverted. Handing it a dark theme background produced a
   * washed-out light canvas that didn't match the mermaid preview beside it.
   *
   * Instead the canvas is cleared to `transparent` (Excalidraw special-cases that
   * string) and the real color goes on the host element behind it. The filter
   * applies to `canvas` only, so the background renders at exactly the requested
   * value while the *drawing* still gets inverted — which is what makes strokes
   * legible on a dark surface. The export path composites its background outside
   * the filter for the same reason.
   */
  const displayBackground = backgroundColor ? 'transparent' : undefined

  // Push theme background changes onto the live canvas. `NEVER` keeps a theme
  // switch out of the undo stack — it's chrome, not an edit the user made. Falling
  // back to the file's own color matters when the theme is cleared to "None".
  useEffect(() => {
    const api = apiRef.current
    if (!apiReady || !api) return
    api.updateScene({
      appState: {
        viewBackgroundColor: displayBackground ?? storedBackgroundRef.current,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }, [apiReady, displayBackground])

  // Frame the drawing when a scene first opens.
  //
  // Scroll and zoom are deliberately *not* part of the saved file — Excalidraw
  // excludes them from `serializeAsJSON`, and persisting them would make merely
  // panning around dirty the file. The cost is that a reopened scene would
  // otherwise land at the canvas origin, with the drawing wherever its absolute
  // coordinates happen to put it — frequently off-screen. `initialData`'s
  // `scrollToContent` is unreliable here because the container is still being laid
  // out at mount, so re-frame once the editor is actually live.
  useEffect(() => {
    const api = apiRef.current
    if (!apiReady || !api) return
    const elements = (initialScene?.elements ?? []).filter((element) => !element.isDeleted)
    if (elements.length === 0) return

    // `excalidrawAPI` hands us the API before the editor has finished its own
    // first layout pass, and scrolling against a viewport it hasn't measured yet
    // gets overwritten moments later. Two frames puts this after that settles.
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        api.scrollToContent(elements, { fitToContent: true })
      })
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [apiReady, initialScene])

  const handleChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      // Excalidraw fires onChange very freely — pointer moves, selection changes,
      // panning. Most of that isn't persisted (`serializeAsJSON` drops scroll,
      // zoom, selection and the active tool), so the common case is a string
      // identical to what we last saw and the comparison below short-circuits.
      const next = serializeAsJSON(
        elements,
        { ...appState, viewBackgroundColor: storedBackgroundRef.current },
        files,
        'local',
      )
      if (next === lastTextRef.current || scenesEqual(next, lastTextRef.current)) return
      lastTextRef.current = next
      onChangeRef.current(next)
    },
    [],
  )

  // Apply changes that came from outside the canvas: recovering a version from
  // history, "start over" after a conflict, or a restored draft arriving late.
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    if (scenesEqual(value, lastTextRef.current)) return

    const scene = parseScene(value)
    if (!scene) {
      setSyncError('That version is not a valid Excalidraw scene, so the canvas was left as-is.')
      return
    }

    setSyncError(null)
    lastTextRef.current = value
    // This scene replaces the current one, so its background becomes the value we
    // preserve on save.
    if (typeof scene.appState?.viewBackgroundColor === 'string') {
      storedBackgroundRef.current = scene.appState.viewBackgroundColor
    }

    // `restore` fills a scene file's partial appState out to a complete one and
    // repairs element bindings, which also migrates scenes written by older
    // Excalidraw versions. Excalidraw applies it to `initialData` internally; on
    // this path we have to call it ourselves.
    const restored = restore(
      { elements: scene.elements, appState: scene.appState, files: scene.files },
      null,
      null,
    )

    // Files must be registered before the elements referencing them render,
    // otherwise embedded images draw as empty placeholders.
    const files = Object.values(restored.files)
    if (files.length > 0) api.addFiles(files)
    api.updateScene({
      elements: restored.elements,
      appState: {
        ...restored.appState,
        ...imposedAppState,
        ...(displayBackground ? { viewBackgroundColor: displayBackground } : {}),
      },
      // Capture into the undo stack so recovering a version can be undone.
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    // `imposedAppState` changes with the theme, but that can't re-run the body:
    // a theme switch leaves `value` matching `lastTextRef`, so the guard above
    // returns first. The theme itself is already on the live canvas by then —
    // Excalidraw applies the `theme` prop on its own when it changes.
  }, [value, displayBackground, imposedAppState])

  return (
    <div
      ref={hostRef}
      className={cn(
        'canvas-host relative bg-background',
        // Marks the read-only preview so globals.css can strip Excalidraw's
        // remaining chrome — `viewModeEnabled` hides the toolbar and panels but
        // leaves the bottom zoom/help island, an opaque card that reads as a stray
        // white box over a history preview.
        viewMode && 'canvas-host--view-mode',
        isMaximized ? 'fixed inset-0 z-50 h-screen w-screen' : 'size-full',
      )}
      // The canvas above this is cleared to transparent, so this is what actually
      // shows as the drawing surface — unfiltered, at the exact theme color.
      style={backgroundColor ? { backgroundColor } : undefined}
    >
      {syncError ? (
        <p className="absolute inset-x-0 top-0 z-10 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {syncError}
        </p>
      ) : null}
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api
          setApiReady(true)
        }}
        initialData={
          initialScene
            ? {
                elements: initialScene.elements,
                appState: {
                  ...initialScene.appState,
                  ...imposedAppState,
                  ...(displayBackground ? { viewBackgroundColor: displayBackground } : {}),
                },
                files: initialScene.files,
                scrollToContent: true,
              }
            : {
                appState: {
                  ...imposedAppState,
                  ...(displayBackground ? { viewBackgroundColor: displayBackground } : {}),
                },
              }
        }
        // Omitted in the read-only preview: it lives inside the history sheet, so
        // filling the window would cover the sheet that opened it, leaving this
        // button as the only way back.
        renderTopRightUI={
          viewMode
            ? undefined
            : () => (
                <button
                  type="button"
                  className="canvas-fullscreen-button"
                  onClick={toggleMaximized}
                  title={isMaximized ? 'Exit full window' : 'Fill window'}
                  aria-label={isMaximized ? 'Exit full window' : 'Fill window'}
                >
                  {isMaximized ? <Minimize2 /> : <Maximize2 />}
                </button>
              )
        }
        onChange={viewMode ? undefined : handleChange}
        theme={theme}
        viewModeEnabled={viewMode}
        UIOptions={{
          canvasActions: {
            // The theme follows the app's active diagram palette, so a toggle
            // here would be overridden on the next render. Hide it rather than
            // ship a dead control.
            toggleTheme: false,
            // Everything below duplicates the app's own Export menu, which is the
            // one place export lives. `saveAsImage` also gates the image-export
            // dialog itself, so hiding it closes the ⌘⇧E path too.
            export: false,
            saveAsImage: false,
            // "Save to disk" both duplicates the Export menu's scene download and
            // binds ⌘S — which is Commit here, so leaving it on meant one keypress
            // inside the canvas fired a commit *and* opened a file-save dialog.
            saveToActiveFile: false,
            // `loadScene` ("Open") stays: importing a scene from disk has no
            // equivalent in the app's own menus.
          },
        }}
      />
    </div>
  )
}
