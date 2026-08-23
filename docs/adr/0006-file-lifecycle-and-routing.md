# 0006. Routing, scratch documents, and the never-committed file

**Status** accepted &nbsp;·&nbsp; **Touches** `app/app/editor/page.tsx, app/components/AppShell.tsx, app/components/NewFileMenu.tsx, app/components/RepoPicker.tsx`

The invariants this record justifies are listed in [`CLAUDE.md`](../../CLAUDE.md). This file holds the reasoning behind them — read it before changing any of them, and update it here when a decision actually changes.

---

## Routing / modes

- `/` — marketing landing (`components/Landing.tsx`). Unauthenticated users start
  here and pick **Local mode** (`/editor?mode=local`) or **GitHub repo mode**
  (sign in → `/editor`).
- `/editor` — the app (`app/editor/page.tsx` → `AppShell`). Reads `auth()`:
  signed-in → `mode="github"` (repo features on); `?mode=local` without a session
  → `mode="local"` (editor + export only); otherwise redirects to `/`.

With a file open, its extension picks the editing surface. With nothing open —
local mode, or before picking a file — there is no extension to read, so the user
chooses via a Diagram/Markdown/Canvas toggle backed by `AppConfig.scratchKind`.
**Each kind gets its own localStorage draft slot** (`SCRATCH_DOC_ID` /
`SCRATCH_MARKDOWN_DOC_ID` / `SCRATCH_SCENE_DOC_ID`, resolved through
`scratchDocIdFor`), so toggling parks the current work instead of overwriting it
with content the other surface can't read. Route every scratch-slot lookup through
`scratchDocIdFor` rather than re-deriving it — a fourth kind must not be able to
silently land in another kind's slot. Anything that forces mermaid content into the
scratch doc (`showRepoStartState`, `resetForRepoSwitch`, `detachEditor`) also
resets `scratchKind` to `'mermaid'`.

### Creating a file: only the name is typed

`NewFileMenu` has already chosen the kind by the time the path prompt opens, so
the extension is settled — and the folder is whichever "+" was used. `PromptModal`
therefore shows both as **uneditable** text around the input (`prefix`/`suffix`),
prefills just `untitled`, and selects it, so typing replaces the name and nothing
else. `onSubmit`/`validate` still receive the assembled path, so
`validatePath`/`templateFor(fileKind(path))` are unchanged; `validateNewFilePath`
adds the one new failure mode (an empty name, which would assemble into `.md`).

A name may still contain `/`, so creating a subfolder from the root "+" works.
**Rename is deliberately different** — it keeps a single free-text path field,
because moving a file between folders is the point of it.

**Renaming a never-committed file is local only.** Such a file is spliced into the
sidebar from `pendingPaths` and its content is a localStorage draft; GitHub has
nothing under either name, so `renameFile` would ask git to move a path that isn't
in the tree and get a 404 back. `requestRename` branches on
`pendingPaths.has(node.path)` and moves the draft slot instead — which is the same
thing creating it under the new name would have done — skipping both the API call
and the tree refresh, since the branch didn't change. The committed path still
lands on GitHub *first*: reordering that would leave the app pointing at a path the
repo never got.

### A never-committed file is a set member, not the open file

`pendingPaths` is what makes an uncommitted new file exist: it is spliced into
`displayNodes`, it routes `openFile` and the agent's `readPath` to the draft
instead of GitHub (which would 404 on a path the branch doesn't have), and it is
the flag rename and delete branch on to skip the API. Three rules hold it
together:

- **It is a set, and it outlives the file being open.** Derived from `openPath`
  alone — which it was — creating a second file or opening any other file dropped
  the first one out of the sidebar with its draft still in localStorage and nothing
  able to reach it: the file appeared to vanish. An agent creating two files in a
  row hit this every time.
- **Creating a file writes its draft immediately**, rather than leaving it to the
  autosave effect. For a file with no commit behind it the draft is the only copy,
  so it must not depend on a render landing between two creates.
- **The draft is the only record such a file leaves**, which is what makes it
  recoverable after a reload (`listDraftPaths`): a draft under a path the branch
  doesn't have can only be a file created here and never committed. That recovery
  runs **once per repo/branch**, on the first tree load — a rename or a commit
  moves a draft before the tree proving where the path now lives has arrived, and
  re-deriving against a stale tree would re-flag a committed path as pending, which
  would send its next rename or delete down the local-only branch and skip GitHub.
  For the same reason `confirmDelete` clears the drafts of everything it deletes:
  a leftover draft *is* a pending file to the recovery pass.
- **A commit hands the path straight to the tree** (`treeWithPath`), in the same
  batch that drops it from `createdPaths`. Membership is what puts the file in the
  sidebar, and committing is exactly what ends it — so waiting for `refreshTree` to
  prove the path is on the branch left one round trip in which the file belonged to
  neither set, and it blinked out of the tree and back for that long. It is
  recorded as **committed**, not left pending: a pending path reads from a draft
  the commit just spent, and sends rename and delete down the local-only branch
  that skips GitHub.

Markdown is listed **first** in `NewFileMenu` and in the scratch-kind toggle: a
document is the most common thing to start, and it can hold diagrams of either
kind inside it.

### Selecting a repository is a precondition, not a setting

Signed in with `config.repo === null` the app can do nothing — no tree, no open,
no commit — so `AppShell` opens `RepoPicker` automatically once per mount rather
than leaving an inert editor on screen. It is a ref-guarded one-shot, so
dismissing it to use the local scratch document doesn't reopen it immediately.

A **fresh sign-in always clears the stored repository**: `loginWithGitHub`
redirects to `/editor?connect=1`, and the hydration effect consumes that flag,
nulls `repo`, persists it, and strips the param via `history.replaceState`.
Stripping matters — without it a reload (or a shared link) would wipe the
selection the user just made. `?mode=local` never carries the flag.
