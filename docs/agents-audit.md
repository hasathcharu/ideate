# Repository instruction audit

Date: 2026-09-14. Scope: all sections of the original `CLAUDE.md`, migrated to
[AGENTS.md](../AGENTS.md), the linked ADRs, and targeted checks against source and
package scripts. This is an instruction-content audit, not a runtime or security
audit of the application. Runtime claims listed below were not reproduced.

## Shortening completed

The approved follow-up reduced `AGENTS.md` from 4,210 to **1,188 words**
(**71.8% shorter**) and from 434 to **148 lines**.
The numbered architectural boundaries remain stable for existing source references.
A required-reading table routes subsystem changes to all 14 ADRs.
Detailed requirements remain in those records, including the added debounce snapshot
contract and canvas verification steps. The ADRs also correct the stale claims about
storage, branch arguments, refresh, Mermaid defaults, Excalidraw imports, and exports.
Agent Link's optional-path and warnings lists now include `scene_render`.

The findings below describe the original guide and the first, content-preserving
migration. They are an audit snapshot, not additional repository instructions.
The live GitHub limitation and write-then-edit race remain unverified runtime concerns.

## Assessment

The guide is bloated because it combines repository boundaries, subsystem contracts,
implementation notes, bug history, setup instructions, and test status. These have
different audiences and lifetimes. The opening promise that the root file states
*what* and ADRs explain *why* is not followed consistently.

The original has **434 lines and 4,210 whitespace-separated words**. Agent Link
accounts for about **1,186 words (28%)**; hard architectural rules add about 674.
There is useful engineering knowledge here. The main problem is duplication and
placement, not that the safeguards are unnecessary.

Recommended target: **roughly 1,000–1,400 words** in the root guide, a reduction of
about 67–76%. This is an editorial target, not a measured result of this change.
Keep consequential boundaries in the root; require reading the relevant ADR before
modifying a subsystem; retain detailed contracts and regression history there.
Do not achieve the target by silently deleting unique rules.

## Migration completed

- `CLAUDE.md` now points to and imports `AGENTS.md`.
- The original instructions are preserved in `AGENTS.md`, changing only the title.
- An existing untracked `AGENTS.md` differed only in its title and a setup command
  changed from `claude` to `Codex`. The migration retains the original Claude command,
  also used by the README; it does not reinterpret that command as Codex syntax.
- ADR backlinks and the two source comments referring to the old canonical filename
  now point to `AGENTS.md`.
- No architectural rules have been shortened or corrected in this migration. The
  findings and proposed changes below are separate from the content-preserving move.

## Corrections needed before shortening

| Finding | Evidence | Recommended correction |
|---|---|---|
| Rule 1 says *all* GitHub API calls are server actions. Authentication is an existing exception. | [auth.ts](../app/auth.ts) exchanges refresh tokens with `fetch`; the provider handles sign-in. | Say repository data operations go through `app/app/actions/github.ts`; auth stays in the server-side Auth.js flow. Keep Octokit server-only. |
| Rule 4 says every read/write action takes `branch`, which is broader than the actual contract. | [github.ts](../app/app/actions/github.ts): `readFileAtRef` takes `ref`; `listBranches`, `listRepos`, and `checkSession` do not take a branch. | Require a caller-selected branch for operations on current branch content; preserve explicit refs for history and branch-independent metadata operations. |
| Rule 6 forbids ref rewrites without clearly distinguishing normal ref updates. | Rule 4 and [ADR 0003](adr/0003-branch-model-and-no-force-push.md) explicitly use `git.updateRef` with `force: false`. | Forbid force updates and history replacement; explicitly allow normal non-forced ref advancement. |
| Rule 7 states the renderer uses the `base` theme unconditionally. | [mermaid.ts](../app/lib/mermaid.ts) sets `BASE_CONFIG.theme` to `default` and merges user configuration. ADR 0007 repeats the stale assertion. | Describe the default and the YAML override separately. Reconcile both documents with the intended product behavior; do not change the renderer merely to satisfy stale prose. |
| Rule 8's blanket ban on module-scope value imports omits the lazy editor exception. | [CanvasInner.tsx](../app/components/CanvasInner.tsx) imports the library and CSS at module scope, behind [Canvas.tsx](../app/components/Canvas.tsx)'s dynamic import. | Permit imports in that lazy editor module; prohibit them in eagerly loaded modules and require per-function imports for utility access. ADR 0009 also still says “exactly two doors,” omitting `sceneEdit.ts`. |
| Rule 14 says refresh happens in `proxy.ts` “and nowhere else,” while its own explanation describes a broader gate. | [auth.ts](../app/auth.ts) implements refresh in the JWT callback when `request` exists, including Auth.js route handlers. [proxy.ts](../app/proxy.ts) invokes that auth flow. | State the real boundary: refresh only through the existing cookie-writable Auth.js request flow; never from RSC renders or `getGitHubToken()`. Keep the prohibition on extra refresh paths and DB/KV locks. |
| The local-mode overview claims only two functions distinguish the stores. | [AppShell.tsx](../app/components/AppShell.tsx) also branches on `localMode` for saving, renaming, deleting, tree construction, and Save All. | Limit the claim to shared document identity/read resolution, or remove the implementation count. |
| Rendering mentions “Markdown + Theme,” but Export explicitly forbids a theme-baking Markdown variant. | [ExportMenu.tsx](../app/components/ExportMenu.tsx) and [ADR 0012](adr/0012-export-pipeline.md) use verbatim Markdown. ADR 0008 still mentions the old variant. | Remove the obsolete variant from rendering guidance and ADR 0008. Distinguish Mermaid source export, which can include config, from Markdown document export. |
| Agent Link is introduced as handing over only the document open on screen. | Its own path rules and [ADR 0011](adr/0011-agent-link.md) cover background documents. | Say it operates on the paired tab's working documents, including files not open on screen. |
| The optional-path list omits `scene_render`; the creation extension list is abbreviated. | [agentProtocol.ts](../app/lib/agentProtocol.ts) includes `scene_render.path?`; [tools.go](../ideate-mcp/internal/tools/tools.go) accepts `.mermaid` and `.markdown` as well as the short extensions for `create_file`. | Include `scene_render` among reads and list all accepted text extensions, or refer to `fileKind` and the schema. Clarify that “ids is the only knob” means the only crop/fidelity control, not the only argument. |
| Source paths switch between root-relative and app-relative without an early convention. | `app/actions/github.ts` is actually `app/app/actions/github.ts` from the repository root; `lib/*` lives under `app/lib/*`. | Put the layout first and use root-relative paths throughout the root guide. |

These are documentation mismatches or scope ambiguities, not a finding that the
corresponding implementation should be changed.

## Section-by-section disposition

| Current section | Keep in the root guide | Move, compress, or remove from the root |
|---|---|---|
| Introduction | Read the relevant ADR before changing its decision. | Add a short rule for when new root guidance is warranted. |
| What this is | GitHub is committed storage; local mode stores saved files locally; three text-backed document kinds. | Move lifecycle explanation and helper names to ADR 0001; remove the “only two places” claim. |
| Hard architectural rules | Server/client boundaries, secret handling, branch safety, atomic GitHub Save All, semantic scene equality, lazy Excalidraw, Agent Link credential and write limits. | Consolidate repeated storage, refresh, rendering, and export details with their topic. Remove numbered cross-references after replacing them with named links. |
| Auth | GitHub App, no added OAuth scope, installation-based access, global expired-session handling. | Put endpoint details, 404 probing mechanics, and response shapes in ADR 0002. Preserve the probe's “only 404 means access lost” condition there. |
| UI stack | One sentence preferring shadcn and Tailwind. | Fold into conventions. |
| Routing / modes | Local files are a workspace; extension chooses kind; drafts belong to a document and workspace. | Keep prompt suffixes, selection behavior, pending-path bookkeeping, one-shot picker logic, and query-flag cleanup in ADR 0006. |
| The text editor | Keep one CodeMirror instance and change document configuration through compartments. | ADR 0005 owns completion count, gutter order, search panel mount/margin behavior, minimap geometry, and line-sync mechanics; ADR 0008 owns token splitting. |
| Rendering & theming | Global config is injected without rewriting saved source; preserve contrast and the sanitization boundary; React owns diagram viewports. | ADRs 0007–0009 own CSS selectors, copy implementation, maximized fallback, scrollbar details, and canvas synchronization. Correct the obsolete export claim first. |
| Uncommitted changes | Local baseline diff; scenes use semantic comparison rather than line diff. | ADR 0010 owns Myers details, cap, state effects, undo transaction, gutter visibility, and history pagination. |
| Agent Link | Credential/TLS rules, no GitHub writes, paired versus attached, explicit mutation targets, both protocol ends and fixtures together. | ADR 0011 owns notification coalescing, reconnect states, rendering limits, arrow routing, font loading, warnings, creation behavior, and echo guards. Retain these contracts there; remove their bug narratives from the root. |
| Export | Markdown source stays verbatim; scenes use their exporter and externally composited background. | ADR 0012 owns SVG normalization, density resolution/caps, and the two dark-export fields. Cross-link canvas rules rather than repeat them. |
| Repository layout | Move near the top: two programs, no npm workspaces, `app/app/`, `app/.env.local`. | ADR 0013 remains the file map. |
| Conventions | Strict TypeScript, `ActionResult`, document-keyed async state, protect newer drafts and the current document when saves finish. | Consolidate dirty-draft rules with lifecycle; keep debounce implementation history, tree refresh/search mechanics, skeleton geometry, and row spacing in ADRs 0006/0014. |
| Verify | Exact commands and explicit manual verification requirements for relevant feature changes. | Move setup and publishing details to READMEs; replace undated “not yet verified” statements with dated verification records. Clarify that docs-only edits need link/content checks, not the entire runtime matrix. |

## Duplication and maintenance risks

- **Rendering and canvas rules repeat across three sections.** Rules 7–11, Rendering,
  Agent Link, and Export restate theme injection, light scene colors, the dark filter,
  and background composition. Keep a single concise root boundary and topic links.
- **Draft lifecycle repeats across storage, routing, Agent Link, and conventions.**
  Consolidate around preserving each document's working copy, retaining newer edits,
  and clearing drafts only when clean. Leave call-site mechanics in the ADRs.
- **Bug history is presented as permanent instruction.** Phrases about the removed
  beta label, the former number of import “doors,” what a missing tool used to do,
  and a previous render implementation explain history rather than the current rule.
- **Numeric references are fragile.** ADR 0002's token bullet refers to refresh as
  “rule 12,” while the root assigns it rule 14. Named ADR/section links avoid this
  drift when reorganizing the root.
- **Some ADRs have drift too.** ADR 0006 still describes local mode as “editor + export
  only”; ADR 0009 retains the old import count; ADR 0008 retains the removed export
  variant. Moving text without reconciling destinations would preserve contradictions.
- **Not every detailed safeguard is already fully captured by its linked ADR.**
  For example, ADR 0014 discusses document-keyed debounce but does not contain the
  root's full single-snapshot/no-render-state-update rule. Preserve that requirement
  in ADR 0014 before removing it from the root; the source comment in `hooks.ts`
  supplies the existing rationale.
- **Undated status becomes folklore.** The write-then-edit race and unverified live
  GitHub flows should have a reproducer/checklist and last-checked date in a tracked
  issue or testing document. This audit does not establish whether either remains
  true. Keep the caution until checked; do not mark it fixed from code inspection.
- **Measurements are not invariants.** Bundle size, font count, compressed manifest
  size, “only vitest file,” and line-count descriptions can age silently. The single
  Vitest file and vendor lifecycle match the current tree/scripts, but counts need
  not become permanent constraints.
- **Setup is client-specific.** A root instruction file shared by agents should link
  to the README's setup section rather than carry a command that invites changing
  one client's name while retaining another client's flags.

## Suggested shorter structure

1. Project and layout: storage model, document kinds, package locations.
2. Non-negotiable boundaries: secrets/server actions, branch safety, working-copy
   integrity, client rendering/lazy canvas, sanitization, Agent Link authority.
3. Before editing: a compact task-to-ADR table covering auth, lifecycle, editor,
   rendering, canvas, diff, Agent Link, export, and shared conventions. Require
   reading the matching entries before modifying those subsystems.
4. Verification: root/app/Go commands, targeted browser matrix links, and the
   requirement to report what was actually exercised.
5. Maintaining instructions: add root rules only for cross-cutting constraints or
   high-impact traps that an agent must know before choosing an implementation.
   Put rationale, selector names, constants, and incident history beside the code
   or in the relevant ADR. Update the existing rule instead of appending a second one.

Keep ADR 0011 as the first destination for Agent Link details. It is already large
(785 lines), so splitting it by protocol, scene operations, and verification may
be useful later; that is a separate documentation change, not a prerequisite for
reducing the root guide.

## Validation of the initial migration

The migration checks that `AGENTS.md` preserves the original tracked `CLAUDE.md`
content except for its heading, that the forwarding file references it, and that
local Markdown file links in the changed guidance and ADRs resolve. Source edits
are comment-only filename replacements. No application behavior changed; build,
Go tests, browser flows, and live GitHub calls were not run for this audit.

## Validation of the shortened guide

Local file links and heading anchors resolve. All 14 rule numbers retain their
original subjects, and the reading table links all 14 ADRs. A comparison against
the original guide checked that detailed safeguards remain in the guide or ADRs.
`git diff --check` passes. The STE-flavored linter reports **1.70 findings per
100 words**, below its 2.5 target. Its word-count method differs from the
whitespace-separated count used for the reduction above.

No application behavior changed. Build, Go tests, browser flows, and live GitHub
calls were not run for this documentation-only follow-up.
