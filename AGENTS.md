# AGENTS.md

Repository instructions. Read the relevant architecture decision records (ADRs) below
**before modifying a subsystem**. Preserve their detailed contracts. Update the record
when a decision changes.

## Project and layout

This diagram editor uses the user's GitHub repository as committed storage. There is
no app database. GitHub Save creates a commit on the selected branch. Local mode saves
files in IndexedDB and has no history, conflicts, branches, or PRs.
Both modes layer uncommitted drafts over saved files.

`fileKind` in `app/lib/tree.ts` selects the document kind by extension:
Mermaid (`.mmd`/`.mermaid`), Markdown (`.md`/`.markdown`), or Excalidraw (`.excalidraw`).
All three store plain text and share the GitHub file lifecycle.

Paths in this guide are relative to the repository root:

- `app/`: Next.js package. Its router is `app/app/`, and its environment file is `app/.env.local`.
- `ideate-mcp/`: separate Go module for Agent Link.
- Root `package.json`: delegates through `npm --prefix app`. There are no npm workspaces.

## Architectural boundaries

Rule numbers remain stable because source comments and ADRs refer to them.

1. **Repository API operations use Server Actions** in `app/app/actions/github.ts`.
   Keep Octokit server-only. Authentication uses the existing server-side Auth.js flow.
2. **Never expose GitHub access or refresh tokens to client code.** Keep them out of
   session callback results, client props, and browser storage. Read credentials
   server-side through `getGitHubToken()`.
3. **IndexedDB holds drafts, local-mode saved files, and cached GitHub copies; localStorage holds only app config.** Report
   document-storage failures. Store Agent Link's switch and pairing code in per-tab
   sessionStorage. Keep `AppConfig.mcpOrigin` in shared config.
4. **Current-content operations take the caller's branch.** History reads take an
   explicit ref. Metadata operations need no artificial branch argument. GitHub
   Save All creates one atomic commit and rejects the whole batch on any SHA conflict.
   The app's Open PR only redirects to GitHub's compare URL. Add no PR-creation or merge logic.
5. **The editor, preview, and canvas are client components.** Do not render them on the server.
6. **Never force-push or replace branch history.** Conflict overwrite refetches the
   latest SHA and commits on top. Normal ref updates use `force: false`.
7. **Use the official Mermaid renderer** through `app/lib/mermaid.ts`, asynchronously
   in the browser. Its fallback theme is `default`. Presets use `base` through YAML.
   Preserve the `htmlLabels: false` and `curve: 'basis'` defaults.
8. **Keep Excalidraw code-split.** Only `app/components/CanvasInner.tsx`, loaded through
   `app/components/Canvas.tsx`'s `dynamic(..., { ssr: false })`, may value-import the library at module scope.
   Utilities use per-function `await import`. Type-only imports are allowed. Keep `app/lib/excalidraw.ts` free of value
   imports. `ExportMenu` accesses the library through `app/lib/exportScene.ts`.
9. **Compare scenes semantically** with `scenesEqual`/`sceneSignature`. Exclude scenes
   from line diffs and byte-based dirty checks.
10. **The displayed canvas background is UI state.** Preserve the file's own background
    when serializing. A theme change must not dirty the document.
11. **Composite canvas backgrounds outside Excalidraw's dark-mode filter**, for display
    and export. Scene exports use Excalidraw's exporters with `exportBackground: false`.
12. **The Agent Link pairing code is a credential.** Allow HTTPS, or HTTP only on
    `localhost`/`127.0.0.1` port 7391. Enforce this on both sides. Never put codes in
    URLs or logs. Logs may contain at most an eight-character hash prefix. Add no CORS
    configuration. Every protocol frame needs a fixture in `ideate-mcp/testdata/frames/`
    in the same change.
13. **Agent tools may modify only the working copy.** Expose no GitHub commit, rename,
    or delete tools. Require `ideate_connect` before document access. Unattached
    `ideate_status` returns metadata only.
14. **Refresh tokens only through the existing cookie-writable Auth.js request flow.**
    The JWT callback requires its lazy-config `request` argument, supplied by the proxy
    or auth routes. Keep `getGitHubToken()` a pure reader. Never refresh during a React
    Server Component render. Add no separate refresh path or DB/KV lock.

## Shared implementation rules

- Use strict TypeScript and `ActionResult<T>` for action failures. At each client
  action-error branch, call `handleExpiredSession(error)` first and return if it handles the error.
- Use a GitHub App without adding OAuth scopes. Discover repositories through app
  installations. Preserve the access-loss probe and mount-time session check in ADR 0002.
- Gate file operations with `hasWorkspace`. Local mode has files even when `repo` is null.
  Resolve scratch slots through `scratchDocIdFor`.
- Persist drafts while dirty or while a named file awaits its first save, even if
  empty; clear clean saved-document drafts. New files need an immediate draft.
  Preserve a dirty draft's original saved revision. Reject invalid envelopes;
  require explicit reconciliation for valid drafts whose base is unknown.
  Preserve newer edits and the current document when an earlier save completes.
- Key debounce state by document identity. Keep its key and value in one snapshot.
  Reuse one CodeMirror instance and switch document settings through compartments.
- Keep Mermaid theme and layout in `AppConfig.mermaidConfig`. Inject config during
  rendering without rewriting saved source. Markdown export emits source verbatim.
- Preserve the contrast floor against each actual surface: 4.5:1 for text, 3:1 for
  `--ring`. Exclude `--border` and `--input`.
- Preserve Markdown's render → sanitize → substitute order. React owns diagram
  viewports. Do not rewrite rendered markup to add decorations or search highlights.
- Agent Link operates on the paired tab's working documents, including background files.
  `edit`, `write`, and `scene_edit` require a path whenever a file is open.
  Only untitled documents are exempt. Ship both ends of protocol-version changes together.
- Prefer shadcn primitives and Tailwind utilities. Keep subsystem-specific UI behavior
  in the linked records below.

## Read before editing

Read every record relevant to the change, including changes that cross subsystem boundaries.
These records contain required behavior and regression details omitted from this summary.

| Work area | Required records |
|---|---|
| Storage model and document kinds | [0001](docs/adr/0001-github-as-the-database.md) |
| GitHub auth, actions, access loss, sessions | [0002](docs/adr/0002-auth-tokens-and-server-actions.md) |
| Branches, commits, conflicts | [0003](docs/adr/0003-branch-model-and-no-force-push.md) |
| Browser storage and per-tab state | [0004](docs/adr/0004-client-state-localstorage-and-per-tab.md) |
| CodeMirror, search, minimap, line sync | [0005](docs/adr/0005-the-text-editor.md) |
| Routing, file lifecycle, sidebar | [0006](docs/adr/0006-file-lifecycle-and-routing.md) |
| Mermaid config, palette, contrast, CSS | [0007](docs/adr/0007-theming-and-the-contrast-floor.md) |
| Markdown rendering, links, copy, search | [0008](docs/adr/0008-markdown-rendering.md) |
| Canvas, scene equality, dark mode | [0009](docs/adr/0009-the-excalidraw-canvas.md) |
| Diff, dirty gutter, version history | [0010](docs/adr/0010-diff-and-the-dirty-gutter.md) |
| Agent Link, protocol, scene tools, fonts | [0011](docs/adr/0011-agent-link.md) |
| SVG, PNG, source export | [0012](docs/adr/0012-export-pipeline.md) |
| Package layout and file map | [0013](docs/adr/0013-repository-layout-and-file-map.md) |
| Shared state, debounce, loading UI | [0014](docs/adr/0014-conventions.md) |

## Verify

For implementation changes, run the checks for the affected program. Protocol changes
require both sets. Run the app checks from the repository root:

```bash
npm run typecheck && npm run build && npm --prefix app run test
```

Run the service checks from `ideate-mcp/`:

```bash
go vet ./... && go test -race ./...
```

The app tests guard frame fixtures, not browser behavior. For Agent Link changes, also
run the [end-to-end matrix](docs/adr/0011-agent-link.md#verifying-it--not-reachable-by-typecheck-or-build).
For Excalidraw chrome changes, reproduce mobile and view modes as described in
[ADR 0009](docs/adr/0009-the-excalidraw-canvas.md#verifying-canvas-chrome).
Live GitHub checks need a registered app and sign-in. See
[verification limits](docs/adr/0002-auth-tokens-and-server-actions.md#live-verification-status).

Never hand-edit or commit generated `app/public/excalidraw-assets/`. Build, dev, and
postinstall generate them. Keep the vendor script's assertions enabled.

For documentation-only changes, check links, rule consistency, and `git diff --check`.
Report which checks ran and which remain unverified.

## Maintaining this guide

Keep this file focused on architecture, shared safeguards, and navigation. Put rationale,
implementation details, setup, and bug history in the relevant ADR or README. Update an
existing rule instead of appending a duplicate. Preserve unique requirements in an ADR
before removing them here. `CLAUDE.md` only forwards to this file.
