/**
 * Product name — shown in the UI, page title and commit messages.
 *
 * Configurable via the `NEXT_PUBLIC_APP_NAME` environment variable (inlined at
 * build time, so it's available in both server and client code). Set it in
 * `.env.local`, e.g. `NEXT_PUBLIC_APP_NAME=SketchMaid`. Falls back to the
 * default below when unset.
 */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'SketchMaid'
