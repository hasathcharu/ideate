import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'

/**
 * Excalidraw scene files, as plain text.
 *
 * A `.excalidraw` file is JSON, so it rides the *entire* existing GitHub path
 * unchanged — `readFile`/`commitFile` base64 it like any other text blob, drafts
 * go to localStorage as strings, and conflict detection stays blob-sha based.
 * Only the editing surface differs (a canvas instead of CodeMirror + preview).
 *
 * IMPORTANT: nothing here may `import` a *value* from `@excalidraw/excalidraw` —
 * that would pull the ~1MB editor bundle into every page that touches this
 * module, defeating the code-splitting in `Canvas.tsx`. Type-only imports are
 * erased at compile time and so are fine. The one function that genuinely needs
 * the library (`serializeAsJSON`) is called inside `Canvas.tsx`, which is
 * dynamically imported.
 */

/** The shape of a `.excalidraw` file. `appState`/`files` are optional because
 *  hand-written and third-party files in the wild often omit them. */
export interface ExcalidrawScene {
  type: 'excalidraw'
  version: number
  source?: string
  elements: readonly ExcalidrawElement[]
  appState?: Partial<AppState>
  files?: BinaryFiles
}

/** The `type` field every Excalidraw scene file carries. */
const SCENE_TYPE = 'excalidraw'

/**
 * A blank scene, used for newly created `.excalidraw` files.
 *
 * `viewBackgroundColor` stays white even when a dark theme is active: Excalidraw
 * renders its dark theme by inverting the canvas at draw time, so a white scene
 * background *is* the dark-theme background. Writing a dark color here instead
 * would double-invert into a light canvas — and would bake a theme choice into
 * the user's file, which is data, not chrome. See `Canvas.tsx`'s `theme` prop.
 */
export const EMPTY_SCENE: string = JSON.stringify(
  {
    type: SCENE_TYPE,
    version: 2,
    source: 'https://github.com/excalidraw/excalidraw',
    elements: [],
    appState: { gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: '#ffffff' },
    files: {},
  },
  null,
  2,
)

/** Parse scene text, or null if it isn't valid Excalidraw JSON. Tolerant by
 *  design: a corrupt or hand-mangled file should surface as an error in the UI,
 *  not throw through the render. */
export function parseScene(text: string): ExcalidrawScene | null {
  if (!text.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const scene = parsed as Record<string, unknown>
  if (scene.type !== SCENE_TYPE) return null
  if (!Array.isArray(scene.elements)) return null
  return scene as unknown as ExcalidrawScene
}

export function isSceneText(text: string): boolean {
  return parseScene(text) !== null
}

/**
 * Per-element fields that change on every mutation without changing what the
 * drawing *is*. They're part of the file format (Excalidraw uses them for
 * collaborative reconciliation), but two scenes differing only in these are the
 * same picture — so they're excluded from the dirty comparison below.
 */
const VOLATILE_ELEMENT_FIELDS = new Set(['version', 'versionNonce', 'updated'])

/**
 * The appState keys Excalidraw actually persists into a scene file
 * (`serializeAsJSON(..., 'local')` whitelists exactly these). Comparing only
 * these means a file that happens to carry extra appState — e.g. one saved by an
 * older Excalidraw version, or by a tool that dumped the whole object — doesn't
 * read as different from the equivalent scene we'd write.
 */
const PERSISTED_APP_STATE_KEYS = [
  'gridModeEnabled',
  'gridSize',
  'gridStep',
  'viewBackgroundColor',
] as const

/**
 * A canonical, comparable form of a scene: sorted keys, volatile fields dropped,
 * appState narrowed to the persisted whitelist. Returns null for unparseable
 * text.
 *
 * This is what makes dirty-tracking work for scenes. Mermaid files compare
 * byte-for-byte (`text !== baseline`), but scene JSON can't: re-serializing a
 * file we just loaded legitimately changes the bytes — key order differs,
 * `source` is rewritten to whichever app wrote it, and appState is renarrowed —
 * so a freshly opened file would show as unsaved before the user touched it.
 * Comparing signatures instead means "dirty" tracks the drawing, not the
 * encoding.
 */
export function sceneSignature(text: string): string | null {
  const scene = parseScene(text)
  if (!scene) return null

  const elements = scene.elements.map((element) => {
    const source = element as unknown as Record<string, unknown>
    const stable: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (VOLATILE_ELEMENT_FIELDS.has(key)) continue
      stable[key] = source[key]
    }
    return stable
  })

  const appState: Record<string, unknown> = {}
  const rawAppState = (scene.appState ?? {}) as Record<string, unknown>
  for (const key of PERSISTED_APP_STATE_KEYS) {
    if (rawAppState[key] !== undefined) appState[key] = rawAppState[key]
  }

  // Only the ids and dataURLs of embedded files matter for equality; the
  // surrounding metadata (created/lastRetrieved timestamps) is bookkeeping.
  const files: Record<string, unknown> = {}
  const rawFiles = (scene.files ?? {}) as Record<string, { dataURL?: unknown; mimeType?: unknown }>
  for (const id of Object.keys(rawFiles).sort()) {
    const entry = rawFiles[id]
    files[id] = { dataURL: entry?.dataURL, mimeType: entry?.mimeType }
  }

  return JSON.stringify({ elements, appState, files })
}

/**
 * Whether two scene texts describe the same drawing. Falls back to exact string
 * comparison when either side is unparseable, so a corrupt file still tracks
 * edits (the user can fix the JSON by hand and the dirty flag stays honest).
 */
export function scenesEqual(a: string, b: string): boolean {
  if (a === b) return true
  const left = sceneSignature(a)
  const right = sceneSignature(b)
  if (left === null || right === null) return false
  return left === right
}
