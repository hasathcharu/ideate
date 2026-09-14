import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'

/**
 * Excalidraw scene files, as plain text. A `.excalidraw` file is JSON, so it rides the *entire*
 * existing GitHub path unchanged — `readFile`/`commitFile` base64 it like any other text blob,
 * drafts go to localStorage as strings, and conflict detection stays blob-sha based.
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

/** A blank scene, used for newly created `.excalidraw` files. */
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

/** Per-element fields that change on every mutation without changing what the drawing *is*. */
const VOLATILE_ELEMENT_FIELDS = new Set(['version', 'versionNonce', 'updated'])

/**
 * The appState keys Excalidraw actually persists into a scene file (`serializeAsJSON(..., 'local')`
 * whitelists exactly these).
 */
const PERSISTED_APP_STATE_KEYS = [
  'gridModeEnabled',
  'gridSize',
  'gridStep',
  'viewBackgroundColor',
] as const

/**
 * A canonical, comparable form of a scene: sorted keys, volatile fields dropped, appState narrowed
 * to the persisted whitelist.
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

/** Whether two scene texts describe the same drawing. */
export function scenesEqual(a: string, b: string): boolean {
  if (a === b) return true
  const left = sceneSignature(a)
  const right = sceneSignature(b)
  if (left === null || right === null) return false
  return left === right
}

/** A one-line description of a scene, for surfaces that can't draw one. */
export function sceneSummary(text: string): string {
  const scene = parseScene(text)
  if (!scene) return 'Not a readable Excalidraw scene.'
  const count = scene.elements.length
  if (count === 0) return 'Excalidraw canvas — empty.'
  return `Excalidraw canvas — ${count} element${count === 1 ? '' : 's'}.`
}
