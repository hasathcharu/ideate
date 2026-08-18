/**
 * Copy Excalidraw's font assets into `public/` so the editor never reaches out to
 * a CDN at runtime.
 *
 * Excalidraw lazily fetches its handwriting fonts (Excalifont, Virgil, …) as
 * per-glyph-range subsets. Left to itself it resolves them against a public CDN;
 * `Canvas.tsx` points `window.EXCALIDRAW_ASSET_PATH` at the directory this script
 * writes instead. The output is gitignored and regenerated on install/build, so
 * the ~13MB of fonts stays out of the repo and can never drift from the installed
 * package version.
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

// Resolve through the package's own entry point rather than hardcoding
// node_modules/, so hoisting layouts (workspaces, pnpm) still find it. Its
// `exports` map only exposes `.` and `./index.css`, so the entry file is the one
// reliable anchor — `fonts/` sits beside it in dist/prod.
const entry = require.resolve('@excalidraw/excalidraw')
const src = join(dirname(entry), 'fonts')
const dest = join(process.cwd(), 'public', 'excalidraw-assets', 'fonts')

await rm(dirname(dest), { recursive: true, force: true })
await mkdir(dirname(dest), { recursive: true })
await cp(src, dest, { recursive: true })

console.log(`vendored excalidraw fonts → ${dest}`)
