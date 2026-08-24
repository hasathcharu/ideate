/**
 * Copy Excalidraw's font assets into `public/` so the editor never reaches out to
 * a CDN at runtime, and write out the `@font-face` descriptors that go with them.
 *
 * Excalidraw lazily fetches its handwriting fonts (Excalifont, Virgil, …) as
 * per-glyph-range subsets. Left to itself it resolves them against a public CDN;
 * `Canvas.tsx` points `window.EXCALIDRAW_ASSET_PATH` at the directory this script
 * writes instead. The output is gitignored and regenerated on install/build, so
 * the ~13MB of fonts stays out of the repo and can never drift from the installed
 * package version.
 *
 * **The manifests are the second half of the job, and the reason this script reads
 * the bundle rather than only copying files.** A vendored woff2 is inert on its own:
 * a font is only usable once a `@font-face` names it, gives it a `unicode-range`
 * and points at the file. Excalidraw builds those declarations *in JavaScript*, and
 * registers them on `document.fonts` when the editor **mounts** — so with no canvas
 * on screen its fonts do not exist, and anything that measures text against them
 * silently measures a substitute face instead. See `lib/excalidrawFonts.ts` for what
 * that cost and `docs/adr/0011-agent-link.md` for the bug it caused.
 *
 * So the descriptors are lifted out of the bundle here, at build time, and the app
 * registers them itself at page load. Lifting them out of minified code is a real
 * coupling to an internal shape, which is why every assumption below is asserted
 * rather than assumed: a shape change fails the build with a message naming what it
 * could not find, instead of shipping an app that measures text wrong.
 */
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

// Resolve through the package's own entry point rather than hardcoding
// node_modules/, so hoisting layouts (workspaces, pnpm) still find it. Its
// `exports` map only exposes `.` and `./index.css`, so the entry file is the one
// reliable anchor — `fonts/` sits beside it in dist/prod.
const entry = require.resolve('@excalidraw/excalidraw')
const distDir = dirname(entry)
const src = join(distDir, 'fonts')
const assetsDir = join(process.cwd(), 'public', 'excalidraw-assets')
const dest = join(assetsDir, 'fonts')

await rm(assetsDir, { recursive: true, force: true })
await mkdir(assetsDir, { recursive: true })
await cp(src, dest, { recursive: true })

/* ------------------------------------------------------------------ */
/* The face manifests                                                  */
/* ------------------------------------------------------------------ */

/** Where the app serves the copied tree from — `Canvas.tsx`'s `ASSET_PATH`. Every
 *  url in a manifest is absolute from the site root, because the code that registers
 *  them is not on a page whose own path is predictable. */
const PUBLIC_PREFIX = '/excalidraw-assets'

/**
 * The CJK fallback, held back into its own manifest.
 *
 * Not a special case for its own sake — a size decision with one name in it. Xiaolai
 * is subset per CJK block, which is 209 faces and 117KB of `unicode-range` metadata
 * against 2.6KB for every other family put together. Registering it at page load
 * would put 40KB gzipped of font bookkeeping in front of every visitor for glyphs
 * almost none of them will type, so the app fetches this tier only when the text it
 * is about to measure actually contains CJK.
 */
const DEFERRED_FAMILY = 'Xiaolai'

const chunks = (await readdir(distDir)).filter((name) => name.endsWith('.js'))
const sources = await Promise.all(
  chunks.map(async (name) => await readFile(join(distDir, name), 'utf8')),
)

/** `var xy="./fonts/Excalifont/Excalifont-Regular-<hash>.woff2"` — the bundle names
 *  every subset as a module-scope constant, and the face arrays reference it. */
const URI_CONSTANT = /var ([A-Za-z_$][\w$]*)\s*=\s*"(\.\/fonts\/[^"]+\.woff2)"/g

/** One entry of a face array: `{uri:ID}` with the descriptors object optional, and
 *  the range inside it either a literal or a reference into the shared table. */
const FACE_ENTRY = /\{uri:([A-Za-z_$][\w$]*)(,descriptors:\{([^}]*)\})?\}/g
const RANGE_LITERAL = /unicodeRange:"([^"]*)"/
const RANGE_REFERENCE = /unicodeRange:[A-Za-z_$][\w$]*\.([A-Z_0-9]+)/

/** The shared range table, `{LATIN:"U+0000-00FF, …", CYRILIC_EXT:"…", …}`. Anchored
 *  on `LATIN` because it is the first key and the only one certain to be present. */
const RANGE_TABLE_ANCHOR = /\{LATIN:"U\+/

const uris = new Map()
for (const source of sources) {
  for (const [, id, path] of source.matchAll(URI_CONSTANT)) uris.set(id, path)
}
if (uris.size === 0) {
  fail('found no `var x = "./fonts/….woff2"` declarations in the bundle')
}

const ranges = readRangeTable(sources)
if (!ranges.LATIN) fail('found no shared unicode-range table (expected a `{LATIN:"U+…"}` object)')

/** family -> [{ url, unicodeRange }] */
const families = new Map()
for (const source of sources) {
  for (const [, id, hasDescriptors, descriptors] of source.matchAll(FACE_ENTRY)) {
    const path = uris.get(id)
    if (!path) continue
    const family = path.split('/')[2]
    // No descriptors at all means the face covers everything (Virgil ships as one
    // file). Omitting `unicodeRange` from the registration says the same thing.
    const unicodeRange = hasDescriptors ? readRange(descriptors, path) : null
    const faces = families.get(family) ?? []
    // The same face array is reachable from more than one chunk; keep one copy.
    if (!faces.some((face) => face.url.endsWith(path.slice(1)))) {
      faces.push({ url: PUBLIC_PREFIX + path.slice(1), ...(unicodeRange ? { unicodeRange } : {}) })
    }
    families.set(family, faces)
  }
}

// Every file that was copied must be accounted for, or it is a font the app cannot
// use and does not know it cannot use — exactly the failure this script exists to
// remove. Reported as a list rather than a count, because the name of the family that
// changed shape is the whole of the diagnosis.
//
// Two mechanisms account for a file, and only one of them is ours. Excalidraw's *UI*
// fonts are plain `@font-face` rules in `index.css`, which the editor's own stylesheet
// registers; they never hold scene text, so they need nothing from us. Read out of the
// CSS rather than exempted by name, so a family moving between the two mechanisms
// upstream is still noticed.
const inStylesheet = await declaredInStylesheet()
const described = new Set([...families.values()].flat().map((face) => face.url))
const orphans = []
for (const family of await readdir(dest)) {
  for (const file of await readdir(join(dest, family))) {
    const url = `${PUBLIC_PREFIX}/fonts/${family}/${file}`
    if (!described.has(url) && !inStylesheet.has(url)) orphans.push(url)
  }
}
if (orphans.length > 0) {
  fail(
    `${orphans.length} vendored font file(s) have no @font-face descriptor in the ` +
      `bundle, so nothing could register them:\n  ${orphans.slice(0, 8).join('\n  ')}` +
      (orphans.length > 8 ? `\n  … and ${orphans.length - 8} more` : ''),
  )
}

// Excalifont by name, because it is not one font among many here: it is the default,
// and therefore the face every label an agent writes is measured against.
if (!families.has('Excalifont')) fail('no Excalifont faces found — it is the default font')
if (!families.has(DEFERRED_FAMILY)) fail(`no ${DEFERRED_FAMILY} faces found`)

const immediate = [...families]
  .filter(([family]) => family !== DEFERRED_FAMILY)
  .flatMap(([family, faces]) => faces.map((face) => ({ family, ...face })))
const deferred = families
  .get(DEFERRED_FAMILY)
  .map((face) => ({ family: DEFERRED_FAMILY, ...face }))

await writeFile(join(assetsDir, 'font-faces.json'), JSON.stringify(immediate))
await writeFile(join(assetsDir, 'font-faces-cjk.json'), JSON.stringify(deferred))

console.log(`vendored excalidraw fonts → ${dest}`)
console.log(
  `wrote font-faces.json (${immediate.length} faces, ` +
    `${[...families.keys()].filter((f) => f !== DEFERRED_FAMILY).length} families) and ` +
    `font-faces-cjk.json (${deferred.length} faces)`,
)

/**
 * The font files Excalidraw's own stylesheet already declares.
 *
 * Its UI fonts (Assistant, at the time of writing) are ordinary `@font-face` rules in
 * `index.css`, not entries in the JS font registry — a different mechanism for a
 * different job, since none of them ever holds scene text.
 */
async function declaredInStylesheet() {
  const css = await readFile(join(distDir, 'index.css'), 'utf8')
  const urls = new Set()
  for (const [, path] of css.matchAll(/url\("(\.\/fonts\/[^"]+\.woff2)"\)/g)) {
    urls.add(PUBLIC_PREFIX + path.slice(1))
  }
  return urls
}

/** The range for one face, from a literal or from the shared table. */
function readRange(descriptors, path) {
  const literal = descriptors.match(RANGE_LITERAL)
  if (literal) return literal[1]
  const reference = descriptors.match(RANGE_REFERENCE)
  if (reference) {
    const range = ranges[reference[1]]
    if (!range) fail(`${path} references unicode range ${reference[1]}, which is not in the table`)
    return range
  }
  // Descriptors that carry only a weight. The face covers everything.
  return null
}

/**
 * The shared range table as a plain object.
 *
 * Read by hand rather than with one regex over the whole object, because the values
 * are long comma-separated range lists and a lazy match across them is how you end
 * up pairing the wrong key with the wrong range.
 */
function readRangeTable(sources) {
  for (const source of sources) {
    const anchor = source.match(RANGE_TABLE_ANCHOR)
    if (!anchor) continue
    const start = anchor.index
    const end = source.indexOf('}', start)
    if (end === -1) continue
    const table = {}
    for (const [, key, value] of source
      .slice(start, end)
      .matchAll(/([A-Z_0-9]+):"([^"]*)"/g)) {
      table[key] = value
    }
    if (table.LATIN) return table
  }
  return {}
}

function fail(message) {
  console.error(
    `vendor-excalidraw-assets: ${message}.\n\n` +
      'This script lifts @font-face descriptors out of the installed ' +
      '@excalidraw/excalidraw bundle, so an upstream change to how that bundle ' +
      'declares its fonts lands here. Re-read the shapes the regexes at the top of ' +
      'this file expect against the new bundle. Do not silence this: without the ' +
      'descriptors the app cannot register the fonts, and text measured against a ' +
      'substitute face produces shapes too small for their own labels.',
  )
  process.exit(1)
}
