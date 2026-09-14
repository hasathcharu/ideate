# 0001. GitHub as the database, and the three document kinds

**Status** accepted &nbsp;·&nbsp; **Touches** `app/lib/tree.ts, app/lib/markdown.ts`

[`AGENTS.md`](../../AGENTS.md) states repository-wide boundaries and required reading. This record defines the detailed subsystem contracts and their reasoning. Read it before modifying this subsystem, and update it when a decision changes.

---

## What this is

A diagram editor that uses **the user's GitHub repo as the database** — there is
no app database, and no server of ours ever stores a document. localStorage holds
the uncommitted working copy; GitHub holds the committed state, on whichever branch
is currently selected. Save = commit; open old version = checkout.

### Local mode has files too, and localStorage is their saved state

The rule above concerns durable storage. Agent Link can relay working documents
through the service, but it does not provide a document database.

What changed is that **local mode has a file system of its own** (`km:file:` in
`lib/storage.ts`). It used to have one scratch document per kind and no way to keep
two diagrams at once, which made the signed-out product a demo rather than a tool —
and made the whole file lifecycle unreachable without a GitHub account.

The shape is deliberately *the same relationship*, not a second concept:

|                  | GitHub mode                | Local mode              |
|------------------|----------------------------|-------------------------|
| Saved state      | a commit on the branch     | `km:file:<path>`        |
| Working copy     | `km:draft:<owner/repo@branch>:<path>` | `km:draft:local:file:<path>` |
| Save means       | commit                     | write the local file    |
| `loadedSha`      | the blob sha               | `'local'` (a sentinel)  |

Because it is the same relationship, the dirty markers, the diff gutter, DiffView,
Restore, draft recovery across a reload, and the agent's own path resolution work
in local mode through the code paths they already used. `AppShell` centralizes
document identity and saved-content reads in `docIdForPath` and `readSaved`.
Writes and tree construction also distinguish the stores.

**What local mode still does not have**, because these are properties of git and
not of a file: history, conflicts, branches, Open PR, and the hover previews on
in-repo markdown links. A markdown link to another local file is also not
clickable yet — `lib/markdown.ts` tags in-repo links only when a repo is
connected.

Two consequences worth naming:

- **localStorage has a quota** (~5MB for everything, drafts included), and a local
  file has no copy anywhere else. `writeLocalFile` is therefore the one storage
  function that *reports* failure instead of swallowing it, and the caller says so
  in a toast. Drafts can hold the only copy of unsaved edits and never-saved
  files. They are not necessarily redundant copies.
- **`repo === null` no longer means "there are no files."** Anything asking that
  question — including `ideate_status`'s `fileCount` — has to ask about the
  workspace, not about the repository.

Three kinds of document, decided purely by file extension (`fileKind` in
`lib/tree.ts`):

- **Mermaid** (`.mmd` / `.mermaid`) — pure diagram source, edited in CodeMirror
  beside a live rendered diagram.
- **Markdown** (`.md` / `.markdown`) — a prose document, edited in CodeMirror
  beside rendered HTML, rendered the way GitHub renders it: GFM extras, raw
  (sanitized) HTML, syntax-highlighted fences, in-repo links. Any ```mermaid
  fence inside it renders as a themed diagram (`lib/markdown.ts`).
- **Excalidraw** (`.excalidraw`) — a JSON scene, edited on a full-bleed canvas.

`.md` is **markdown, not mermaid**. A `.md` file holding bare mermaid source
(how this app treated the extension before markdown support) now renders as a
paragraph of text — wrap it in a ```mermaid fence or rename it to `.mmd`.

All three are plain text on disk, which is why they share *every* GitHub path
(read/commit/rename/delete/history/conflicts) with no branching. Only the editing
surface and the export pipeline differ.
