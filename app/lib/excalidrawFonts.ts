/** Register Excalidraw's scene fonts on `document.fonts`, without an editor. */

/** Written by `scripts/vendor-excalidraw-assets.mjs` next to the fonts it copies. */
const MANIFEST_URL = '/excalidraw-assets/font-faces.json'

/** The CJK fallback, held back to its own manifest and fetched only when needed. */
const CJK_MANIFEST_URL = '/excalidraw-assets/font-faces-cjk.json'

/**
 * Does this text need the CJK tier? The scripts Xiaolai is there to cover, plus the CJK symbol and
 * punctuation block.
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

/**
 * One attempt per tier per page, kept as the promise rather than a boolean so concurrent callers
 * await the same fetch instead of racing to start their own.
 */
const attempts = new Map<string, Promise<boolean>>()

/** Make sure the faces needed to measure `characters` are registered, and report whether they are. */
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
      // Adding a face does not fetch it — the browser resolves the woff2 only when something is
      // measured or drawn in a range this face covers, which is why registering all 21 of them at
      // page load costs nothing but the manifest.
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
