# 0001. GitHub as the database, and the three document kinds

**Status** accepted &nbsp;·&nbsp; **Touches** `app/lib/tree.ts, app/lib/markdown.ts`

[`AGENTS.md`](../../AGENTS.md) states repository-wide boundaries and required reading. This record defines the detailed subsystem contracts and their reasoning. Read it before modifying this subsystem, and update it when a decision changes.

---

## What this is

A diagram editor that uses **the user's GitHub repo as the database** — there is
no app database, and no server of ours ever stores a document. IndexedDB holds
the uncommitted working copy and a disposable cache of committed GitHub file
bodies; GitHub remains the authority for committed state on the selected branch.
Save = commit; open old version = checkout.

### Local mode has files too, and IndexedDB is their saved state

The rule above concerns durable storage. Agent Link can relay working documents
through the service, but it does not provide a document database.

**Local mode has its own file system** (the `local-files` IndexedDB store in `lib/storage.ts`). Users can
create and save multiple files without a GitHub account.

The shape is deliberately *the same relationship*, not a second concept:

|                  | GitHub mode                | Local mode              |
|------------------|----------------------------|-------------------------|
| Saved state      | a commit on the branch (`github-files` is a browser cache) | `local-files[path]` in IndexedDB |
| Working copy     | `drafts[owner/repo@branch:path]` | `drafts[local:file:path]` |
| Save means       | commit                     | write the local file    |
| `loadedSha`      | the blob sha               | `'local'` (a sentinel)  |

The dirty markers, diff gutter, DiffView, Restore, draft recovery across a reload,
and agent path resolution work in both modes. `AppShell` centralizes
document identity and saved-content reads in `docIdForPath` and `readSaved`.
Writes and tree construction also distinguish the stores.

The browser working copy also has a `WorkspaceStore` record keyed by mode,
repository, branch, path, and kind. Its saved baseline and working revision are
in-memory coordination data; GitHub commits and local saved files remain the
saved stores. A successful delayed save advances the originating record's saved
baseline without replacing newer working content. The IndexedDB document store is browser-side persistence and does not change this boundary.

Local mode has no Git history, conflicts, branches, Open PR, or hover previews on
in-repo Markdown links. A Markdown link to another local file is also not
clickable yet — `lib/markdown.ts` tags in-repo links only when a repo is
connected.

Two consequences worth naming:

- **IndexedDB has a larger, browser-dependent quota and can still be evicted**, and a local
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

PNG, JPG, GIF, and SVG repository assets are also surfaced in the file tree so
documents can keep their referenced images alongside their source. They are not
additional document kinds: raster assets are read-only image previews, while SVG
is text-backed and uses the editor/preview split. Both image previews reuse the
diagram viewport's zoom, pan, fit, and full-window controls. Opening an image is refused
above 30 MB; generating and committing an export has no such render-time limit.
The new-file menu also accepts these four formats through a drop zone. Uploads
preserve the original bytes and prompt for a repository-relative destination.
