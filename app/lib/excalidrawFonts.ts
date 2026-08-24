/**
 * Register Excalidraw's scene fonts on `document.fonts`, without an editor.
 *
 * **Why this exists.** Excalidraw builds its `@font-face` declarations in
 * JavaScript and registers them when the editor *mounts*. Importing the library
 * does not do it, and the library exports no way to ask for it — the registry, the
 * declaration generator and `Fonts.loadElementsFonts` are all internal. So on a page
 * with no canvas on screen, Excalifont does not exist as far as the browser is
 * concerned.
 *
 * That matters because a shape holding a label is *sized* from a canvas
 * `measureText` against `20px Excalifont, Xiaolai, "Segoe UI Emoji"` — and a canvas
 * silently substitutes a generic face for a font that has not loaded rather than
 * failing. Excalifont is handwriting and ~20% wider than that substitute, so every
 * box came out sized for a font it would not be drawn in and clipped its own label.
 * Waiting for the editor to mount only ever half-fixed it: `ideate_scene_edit` is
 * *meant* to work on a file the human is not looking at, so for its main use there is
 * no editor to wait for.
 *
 * So the declarations are lifted out of the bundle at build time by
 * `scripts/vendor-excalidraw-assets.mjs`, beside the woff2 files it already copies,
 * and this registers them from the manifest at page load. After that a scene edit
 * measures text correctly whether or not a canvas has ever been open.
 *
 * **Rule 8 is untouched** — there is no import of `@excalidraw/excalidraw` here, of
 * either kind. A `FontFace` pointing at a vendored woff2 is a browser API and a URL,
 * which is the whole reason this can run on page load: it costs a 1.3KB fetch and no
 * part of the ~1MB editor bundle. The woff2 files themselves are fetched lazily by
 * the browser, only for the faces something actually measures against.
 */

/** Written by `scripts/vendor-excalidraw-assets.mjs` next to the fonts it copies. */
const MANIFEST_URL = '/excalidraw-assets/font-faces.json'

/**
 * The CJK fallback, held back to its own manifest and fetched only when needed.
 *
 * Xiaolai is subset per CJK block: 209 faces and ~40KB gzipped of `unicode-range`
 * bookkeeping, against 1.3KB for every other family together. Registering it on every
 * page load would charge every visitor for glyphs almost none of them will type.
 */
const CJK_MANIFEST_URL = '/excalidraw-assets/font-faces-cjk.json'

/**
 * Does this text need the CJK tier?
 *
 * The scripts Xiaolai is there to cover, plus the CJK symbol and punctuation block.
 * A heuristic, deliberately: the exact answer is in the 40KB of ranges this test
 * exists to avoid fetching. It is a *safe* heuristic — being wrong costs a slightly
 * narrow box and a `font_unavailable` warning saying so, which is the same answer the
 * caller would get if the fetch had failed.
 */
const NEEDS_CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}　-〿]/u

/** One `@font-face` worth of manifest. `unicodeRange` is absent for a family that
 *  ships as a single file covering everything (Virgil). */
interface FaceDescriptor {
  family: string
  url: string
  unicodeRange?: string
}

/** One attempt per tier per page, kept as the promise rather than a boolean so
 *  concurrent callers await the same fetch instead of racing to start their own.
 *  A failed attempt is not retried: the manifest is a static file served from the
 *  same origin, so a failure is a deployment problem and hammering it would not fix
 *  one. */
const attempts = new Map<string, Promise<boolean>>()

/**
 * Make sure the faces needed to measure `characters` are registered, and report
 * whether they are.
 *
 * Safe and cheap to call repeatedly — the work happens once per tier per page. Call
 * it once on mount to warm the fonts up, and again from anything about to measure,
 * which is what makes the measurement independent of whether the warm-up finished.
 */
export function ensureExcalidrawFonts(characters = ''): Promise<boolean> {
  const tiers = [register(MANIFEST_URL)]
  if (NEEDS_CJK.test(characters)) tiers.push(register(CJK_MANIFEST_URL))
  return Promise.all(tiers).then((results) => results.every(Boolean))
}

function register(url: string): Promise<boolean> {
  const started = attempts.get(url)
  if (started) return started
  const attempt = addFaces(url)
  attempts.set(url, attempt)
  return attempt
}

async function addFaces(url: string): Promise<boolean> {
  if (typeof document === 'undefined' || !document.fonts || typeof FontFace === 'undefined') {
    return false
  }
  try {
    const response = await fetch(url)
    if (!response.ok) return false
    const faces = (await response.json()) as FaceDescriptor[]
    if (!Array.isArray(faces) || faces.length === 0) return false
    for (const face of faces) {
      // Adding a face does not fetch it — the browser resolves the woff2 only when
      // something is measured or drawn in a range this face covers, which is why
      // registering all 21 of them at page load costs nothing but the manifest.
      //
      // If the editor mounts later it will register its own copies of these, because
      // it checks `document.fonts.has` against its own `FontFace` objects and ours
      // are different objects. Harmless: identical family, identical range,
      // identical URL, so the browser serves one file and matching cannot tell them
      // apart.
      document.fonts.add(
        new FontFace(
          face.family,
          `url("${face.url}") format("woff2")`,
          face.unicodeRange ? { unicodeRange: face.unicodeRange } : {},
        ),
      )
    }
    return true
  } catch {
    // A missing manifest, a malformed one, or a `FontFace` the browser refuses. All
    // of them mean the same thing to the caller — measurements will be against a
    // substitute face — and none of them is a reason to fail an edit outright.
    return false
  }
}
