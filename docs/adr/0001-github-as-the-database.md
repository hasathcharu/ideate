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

**Local mode has its own file system** (`km:file:` in `lib/storage.ts`). Users can
create and save multiple files without a GitHub account.

The shape is deliberately *the same relationship*, not a second concept:

|                  | GitHub mode                | Local mode              |
|------------------|----------------------------|-------------------------|
| Saved state      | a commit on the branch     | `km:file:<path>`        |
| Working copy     | `km:draft:<owner/repo@branch>:<path>` | `km:draft:local:file:<path>` |
| Save means       | commit                     | write the local file    |
| `loadedSha`      | the blob sha               | `'local'` (a sentinel)  |

The dirty markers, diff gutter, DiffView, Restore, draft recovery across a reload,
and agent path resolution work in both modes. `AppShell` centralizes
document identity and saved-content reads in `docIdForPath` and `readSaved`.
Writes and tree construction also distinguish the stores.

Local mode has no Git history, conflicts, branches, Open PR, or hover previews on
in-repo Markdown links. A Markdown link to another local file is also not
clickable yet — `lib/markdown.ts` tags in-repo links only when a repo is
connected.

Two consequences worth naming:

- **localStorage has a quota** (~5MB for everything, drafts included), and a local
  file has no copy anywhere else. Content reads distinguish missing, invalid and
  unavailable storage; writes, moves and deletes report failure. A failed draft
  write blocks navigation rather than claiming the working copy is durable.
  Drafts can hold the only copy of unsaved edits and never-saved files. They are
  not necessarily redundant copies.
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

`.md` is **Markdown**. Bare Mermaid source in a `.md` file renders as text. Wrap
it in a ```mermaid fence or use `.mmd`.

All three are plain text on disk, which is why they share *every* GitHub path
(read/commit/rename/delete/history/conflicts) with no branching. Only the editing
surface and the export pipeline differ.
