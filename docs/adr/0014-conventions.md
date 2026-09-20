# 0014. Conventions, and the bugs behind them

**Status** accepted &nbsp;·&nbsp; **Touches** `app/lib/hooks.ts, app/components/AppShell.tsx, app/components/ui/skeleton.tsx`

[`AGENTS.md`](../../AGENTS.md) states repository-wide boundaries and required reading. This record defines the detailed subsystem contracts and their reasoning. Read it before modifying this subsystem, and update it when a decision changes.

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
  (preview and export) sees the *outgoing* document for a full delay window.
  That can render scene JSON as a Mermaid parse error. Keep the key and value in
  one `{key, value}` snapshot. On a key mismatch, return the incoming value directly. Do not replace
  this with two state setters during render: a pass can commit with the outgoing
  value and mount a preview for the wrong document. The effect updates the snapshot
  after the delay while the document identity stays the same.
- **The scratch/file draft is written only while the document is dirty**, or
  while a named file is pending its first save. Persistence uses live text,
  independently of preview debounce. Navigation flushes an outgoing draft and
  stays on the document if the write fails. A clean saved document clears its
  draft (the autosave effect in `AppShell`). Saving
  unconditionally would persist the starter template as a draft and prevent later
  updates to `templateFor` from reaching untouched documents. Keep the dirty or
  pending gate on any new autosave path.
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
