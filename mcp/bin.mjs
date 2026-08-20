#!/usr/bin/env node
/**
 * Entry point for `npx github:hasathcharu/ideate`.
 *
 * A `.mjs` shim rather than the TypeScript directly: a consumer installing this
 * from git gets `dependencies` only, so no TypeScript loader is present at
 * runtime. `dist-mcp/` is produced by the `prepare` script, which npm runs after
 * it installs a git dependency (with devDependencies available) and before it
 * packs — which is the hook that makes running straight from GitHub work.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'dist-mcp', 'mcp', 'index.js')

if (!existsSync(entry)) {
  process.stderr.write(
    'ideate-mcp: dist-mcp/ is missing — the build step did not run.\n' +
      'From a checkout, run `npm run build:mcp` (or just `npm run mcp`, which runs\n' +
      'the TypeScript directly and needs no build).\n',
  )
  process.exit(1)
}

await import(entry)
