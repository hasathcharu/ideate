# 0006. Routing, scratch documents, and the never-committed file

**Status** accepted &nbsp;·&nbsp; **Touches** `app/app/editor/page.tsx, app/components/AppShell.tsx, app/components/NewFileMenu.tsx, app/components/RepoPicker.tsx`

[`AGENTS.md`](../../AGENTS.md) states repository-wide boundaries and required reading. This record defines the detailed subsystem contracts and their reasoning. Read it before modifying this subsystem, and update it when a decision changes.

---

## Routing / modes

- `/` — marketing landing (`components/Landing.tsx`). Unauthenticated users start
  here and pick **Local mode** (`/editor?mode=local`) or **GitHub repo mode**
  (sign in → `/editor`).
- `/editor` — the app (`app/editor/page.tsx` → `AppShell`). Reads `auth()`:
  signed-in → `mode="github"` (repo features on); `?mode=local` without a session
  → `mode="local"` (local files, editor, and export); otherwise redirects to `/`.

Both modes have a file tree, Save, and Restore. Gate them with `hasWorkspace`
(a selected repository or local mode), not `githubEnabled`. A signed-in user
without a selected repository has neither workspace.

With a file open, its extension picks the editing surface. With nothing open,
there is no extension to read, so the user
chooses via a Diagram/Markdown/Canvas toggle backed by `AppConfig.scratchKind`.

**That toggle is a start-state affordance, offered only while the workspace is
empty** (`workspaceEmpty` in `AppShell`). A workspace that already holds files is
one where the answer to "what am I editing" is a file in the tree, not a kind of
untitled document. It hangs off *"the file list has answered and is empty"*, never
off an empty path list alone: an empty list is also what "still loading" looks
like, and gating on that flashed the toggle on and then off for the length of the
load.

For the same reason, a workspace with files and nothing open does **not** fall back
to an untitled mermaid document. `awaitingFileChoice` puts a **No file open** prompt
on the surface instead, pointing at the sidebar and its "+". It is additionally
gated on the scratch document being empty, so parked scratch work stays reachable —
with the kind toggle gone there would be no other route back to it.

### The last file open is remembered per workspace

`AppConfig.lastOpenPaths` maps a `workspaceKey` to the path that workspace was last
editing, so a reload lands back on the file the user was working on rather than on
the prompt above. It is **keyed by workspace, not a single path**, because config is
shared by every workspace on the origin and a bare path from one repo can exist in
another — a remembered `README.md` would reopen the wrong file after a repo switch.

Three properties hold it together:

- **Restoration waits for the file list, and verifies against it.** A path that has
  been renamed, deleted or committed away must fall through to the prompt, not to a
  failed read. It runs at most once per workspace and never over a document that the
  user or the draft recovery already put on screen.
- **It is recorded from the open document, not from the act of opening**, so a path
  that turned out to be unreadable is never the one restored next time.
- **The map is bounded** (`LAST_OPEN_LIMIT`, newest first). Every repo *and branch*
  is its own workspace key, so this is the only part of a single localStorage value
  that would otherwise grow without limit.
**Each kind gets its own IndexedDB draft slot** (`SCRATCH_DOC_ID` /
`SCRATCH_MARKDOWN_DOC_ID` / `SCRATCH_SCENE_DOC_ID`, resolved through
`scratchDocIdFor`), so toggling parks the current work instead of overwriting it
with content the other surface can't read. Route every scratch-slot lookup through
`scratchDocIdFor` rather than re-deriving it — a fourth kind must not be able to
silently land in another kind's slot. Anything that puts the user back on the
scratch doc (`showRepoStartState`, `resetForRepoSwitch`, `detachEditor`) also
resets `scratchKind` to `'mermaid'`. None of them seeds content into it: each
leaves the surface empty and lets the rules below decide what belongs there —
`detachEditor` in particular runs after a **delete**, and handing back a starter
template there made the delete look like it had opened something.

### Creating a file: only the name is typed

`NewFileMenu` has already chosen the kind by the time the path prompt opens, so
the extension is settled — and the folder is whichever "+" was used. `PromptModal`
therefore shows both as **uneditable** text around the input (`prefix`/`suffix`),
prefills just `untitled`, and selects it, so typing replaces the name and nothing
else. `onSubmit`/`validate` still receive the assembled path, so
`validatePath`/`templateFor(fileKind(path))` are unchanged; `validateNewFilePath`
adds the one new failure mode (an empty name, which would assemble into `.md`).

A name may still contain `/`, so creating a subfolder from the root "+" works.

### Rename: the path is free text, the extension is not

**Rename keeps a single free-text path field**, because moving a file between
folders is the point of it — that is the one way it differs from creating a file,
which knows its folder already. But the **extension is a fixed `suffix` there
too**. Changing it would change the file's *kind*: the editor it opens in, the
exporters it uses, whether its content parses at all. A rename has no business
doing that silently to content that already exists, and save-as (`onFork`) is the
deliberate way to write a document to a different kind — with `validatePathForKind`
checking the pairing.

Only the **name** is preselected (`PromptModal`'s `selection: 'name'`, which
selects from after the last `/`). The folder is still there and still editable;
selecting the whole path meant the first keystroke threw it away, which is the
opposite of what a free-text path field is for.

### The sidebar's search filters what is already loaded

No call behind it, in either mode: `visibleNodes` is `buildTree` over the paths
that match, so a folder whose *name* matched keeps everything under it and a folder
that merely contains a match still appears as the route to it. Matching is every
whitespace-separated term appearing somewhere in the **path**, which is what makes
a folder name a usable search term.

A search starts with every folder open — a result buried in a collapsed folder is
a result the search did not deliver — so it cannot be driven by `expandedPaths`.
Folders collapsed *while searching* go into their own short-lived set, which keeps
the chevrons working without letting a search silently rewrite the layout the user
returns to. The filter itself is in memory only: one left on across a reload is a
sidebar that looks like a repo with three files in it.

**Renaming a never-committed file is local only.** Such a file is spliced into the
sidebar from `pendingPaths` and its content is an IndexedDB draft; GitHub has
nothing under either name, so `renameFile` would ask git to move a path that isn't
in the tree and get a 404 back. `requestRename` branches on
`pendingPaths.has(node.path)` and moves the draft record in one IndexedDB transaction instead — which is the same
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

- **It is a set, and it outlives the file being open.** Deriving pending files
  from `openPath` would lose files from the sidebar as soon as another file opens.
- **Creating a file writes its draft immediately**, rather than leaving it to the
  autosave effect. For a file with no commit behind it the draft is the only copy,
  so it must not depend on a render landing between two creates.
- **Existence is independent of content.** An empty never-saved named file stays
  pending and keeps an empty draft. Create and rename reject known saved and
  pending destinations, and local operations check browser storage itself before
  replacing a destination. A failed move keeps the source copy.
- **The draft is the only record such a file leaves**, which is what makes it
  recoverable after a reload (`listDraftPathsResult`): a draft under a path the branch
  doesn't have can only be a file created here and never committed. That recovery
  runs **once per repo/branch**, on the first tree load — a rename or a commit
  moves a draft before the updated tree arrives. Re-deriving against a stale tree
  would re-flag a committed path as pending, which
  would send its next rename or delete down the local-only branch and skip GitHub.
  For the same reason `confirmDelete` clears the drafts of everything it deletes:
  a leftover draft *is* a pending file to the recovery pass.
- **A commit that lands after the user moved on must not adopt itself.** A commit is
  a round trip, and picking another file during it is exactly what people do — the
  button's whole point is that they are done with this one. `commitCurrent` captures
  the full document key and activation generation:
  `baseline`/`loadedSha`/`openPath` are applied only if that document is still on
  screen (which is also what promotes an untitled one), and otherwise
  `settleCommitted` clears the originating path's draft and dirty marker. It clears
  them **only if the draft still matches what was
  committed**: a user who kept typing between the click and the switch has newer text
  in there, and that text is the only copy of those keystrokes, so the file stays
  dirty.
  Settlement also records the returned saved content and SHA under the full
  originating workspace/document key. The current view adopts them only while
  its activation generation still matches. A later edit keeps its working
  content and remains dirty against the newly saved baseline.
- **A scratch slot is spent only by its own successful promotion.** Saving an
  already-named file or using Save All leaves parked scratch work untouched. A
  delayed scratch save clears its draft only if the submitted working revision
  is still current and the stored draft still contains the submitted content.
- **A commit hands the path straight to the tree** (`treeWithPath`), in the same
  batch that drops it from `createdPaths`. Membership is what puts the file in the
  sidebar, and committing is exactly what ends it — so waiting for `refreshTree` to
  prove the path is on the branch would briefly remove it from the tree. It is
  recorded as **committed**, not left pending: a pending path reads from a draft
  the commit just spent, and sends rename and delete down the local-only branch
  that skips GitHub.

File and tree requests carry a selection generation. A response from an older
repository, branch, or file selection cannot replace the current view. History
page and version reads use the same latest-request rule.

History display pages are slices of a stable upstream commit stream. The server
uses a fixed GitHub page size, applies rename-away filtering before display
pagination, and preserves surplus records so every commit appears exactly once.

When a saved GitHub file has a draft, opening it compares the draft's recorded
base SHA with the current file SHA. A changed or unknown base opens the working
text in an explicit reconciliation state. Save and Save All refuse to pair that
text with the new SHA until the user chooses to keep it on top of the latest
revision or discard it and start from the latest content. There is no migration
path for the unversioned development draft format because it was never released.

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
