# Architecture decision records

`CLAUDE.md` at the repo root states the invariants — what to do and what never to do.
These records hold the reasoning: what was tried, what broke, and why each rule is
worded the way it is. Read the record before changing the rule it justifies, and
update the record when a decision actually changes.

| # | Record | Covers |
|---|---|---|
| 0001 | [GitHub as the database](0001-github-as-the-database.md) | no app database; the three document kinds |
| 0002 | [Auth, tokens and server actions](0002-auth-tokens-and-server-actions.md) | GitHub App, token refresh, dead sessions |
| 0003 | [Branch model, no force-push](0003-branch-model-and-no-force-push.md) | caller-supplied branch, overwrite-on-conflict |
| 0004 | [Client state](0004-client-state-localstorage-and-per-tab.md) | localStorage vs. per-tab sessionStorage |
| 0005 | [The text editor](0005-the-text-editor.md) | CodeMirror setup, theming, viewfinder, line sync |
| 0006 | [File lifecycle and routing](0006-file-lifecycle-and-routing.md) | scratch docs, `pendingPaths`, repo selection |
| 0007 | [Theming and the contrast floor](0007-theming-and-the-contrast-floor.md) | palette → chrome, WCAG lift, native chrome |
| 0008 | [Markdown rendering](0008-markdown-rendering.md) | GitHub-parity render, sanitize order, repo links |
| 0009 | [The Excalidraw canvas](0009-the-excalidraw-canvas.md) | code-splitting, dirty-tracking, dark-mode filter |
| 0010 | [Diff and the dirty gutter](0010-diff-and-the-dirty-gutter.md) | Myers diff, gutter, peek popup, revert |
| 0011 | [Agent Link](0011-agent-link.md) | remote service, pairing code, wire contract, edits |
| 0012 | [Export pipeline](0012-export-pipeline.md) | standalone SVG, PNG scale, scene exporters |
| 0013 | [Repository layout and file map](0013-repository-layout-and-file-map.md) | two programs, one repo; non-obvious files |
| 0014 | [Conventions](0014-conventions.md) | debounce keying, draft autosave, tree refresh, list rows |
