# 0014. Conventions, and the bugs behind them

**Status** accepted &nbsp;·&nbsp; **Touches** `app/lib/hooks, app/components/AppShell.tsx, app/components/ui/skeleton.tsx`

The invariants this record justifies are listed in [`CLAUDE.md`](../../CLAUDE.md). This file holds the reasoning behind them — read it before changing any of them, and update it here when a decision actually changes.

---

## Conventions

- TypeScript strict; server actions return `ActionResult<T>` so the client can
  branch on errors (especially `kind: 'conflict'` for 409/422, and
  `kind: 'unauthenticated'` for 401 / a dead session) without try/catch.
- Keep server-only code out of client bundles; `lib/session.server.ts` imports
  `server-only` as a guard.
- **`useDebouncedValue` must stay keyed on the open document** (`docId`). It takes a
  `resetKey` that adopts the incoming value immediately when it changes; a delay
  only makes sense while editing *one* document. Unkeyed, everything downstream
  (preview, export, the draft autosave) sees the *outgoing* document for a full
  delay window — which rendered mermaid's parse-error dump for the scene JSON on
  every canvas→diagram switch, and wrote the previous file's text into the new
  file's localStorage draft slot.
- **The scratch/file draft is written only while the document is dirty**, and
  cleared the moment it isn't (the autosave effect in `AppShell`). Saving
  unconditionally persisted the auto-inserted starter template as a draft as soon
  as it was displayed; that draft then won on every later load, so anyone who had
  merely *opened* a scratch document was pinned to the template text of that day
  and edits to `templateFor` never reached them. Keep the `dirty` gate on any new
  autosave path.
- **`refreshTree` never blanks the list.** Discarding the stale list is the caller's
  decision, and only the first load and a repo/branch switch
  (`resetForRepoSwitch`) want it; the incidental refreshes after a
  commit/delete/rename keep the list up and swap it when data arrives. A refresh
  that *fails* while a list is on screen shows an inline banner and keeps the list.
  `treeLoading` is tracked separately from `tree === null` for exactly this reason.
- Loading states for lists use `components/ui/skeleton.tsx` with per-call-site
  geometry that mirrors the real rows (indent, padding, line count), so content
  doesn't jump when it swaps in.
- **A list whose rows have both a hover fill and an active tint needs a pixel of
  gap between them** (`space-y-px` — the file tree, the markdown reading view's
  Contents panel). Both states paint a full-width rounded rectangle, so flush rows
  meet edge to edge and a hovered row beside the active one reads as one selected
  block rather than two.
