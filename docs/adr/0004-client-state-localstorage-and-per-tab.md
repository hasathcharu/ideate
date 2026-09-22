# 0004. Browser persistence and per-tab state

**Status** accepted &nbsp;·&nbsp; **Touches** `app/lib/types.ts, app/lib/agentLink.ts, app/lib/mcpOrigin.ts`

[`AGENTS.md`](../../AGENTS.md) states repository-wide boundaries and required reading. This record defines the detailed subsystem contracts and their reasoning. Read it before modifying this subsystem, and update it when a decision changes.

---

## Rule 3

**IndexedDB stores document content**: local-mode saved files in `local-files` and uncommitted drafts in `drafts`. **localStorage stores only app config**
(selected repo, active theme, export prefs, scratch-document kind, preferred commit action, editor
line-wrap and viewfinder, **and the Agent Link service origin**). Never
tokens/secrets. Two pieces of Agent Link state are deliberately *not* in
`AppConfig` and live in `sessionStorage` instead, because config is shared by
every tab on the origin:
- **The on/off switch** (`loadAgentLink`/`saveAgentLink`). In config it was
  shared by the whole origin, so switching it on once armed every tab
  afterwards, they all raced for the bridge, and whichever won became the tab
  the agent drove — leaving the human no way to choose.
- **The pairing code** (`loadPairingCode`/`savePairingCode`), for that reason
  and one more: it is the name *this tab* answers to, so sharing it across the
  origin would make every tab answer to the same code and reintroduce exactly
  that race.

Both survive a reload, which a plain `useState` would not — and for the code
that matters twice over, since coming back under a different one would strand
an agent holding a code that reaches nothing. **`AppConfig.mcpOrigin` is the
opposite case and belongs in config**: *where the service is* is a property of
the deployment, not of one tab, and it is a URL rather than a credential.

Content storage has explicit read outcomes: present, missing, invalid data, or
unavailable storage. Draft and local-file writes report quota/access failure.
Moves check the destination and change source and destination in one transaction. Local
saves, renames, and deletes update related saved-file and draft records atomically. A
multi-document Agent Link patch likewise puts or clears every affected draft in one
`drafts` transaction before any working-copy record acknowledges the patch. A
transaction reports success only after completion; abort, quota, blocked-open, and upgrade
failures are unavailable or quota outcomes, never an empty workspace. The per-tab Agent Link state
remains separate from these document records.

`WorkspaceStore` is the in-memory owner for working document revisions and save
settlement. Its keys include full workspace identity so equal paths in two
repositories or branches are separate records. Document storage is asynchronous. Writes enter an ordered queue, and navigation awaits
the outgoing dirty draft before changing the active document. Legacy `km:file:` and
`km:draft:` localStorage records are deliberately neither imported, read through, nor
deleted: this storage generation starts empty.

Draft values use a versioned envelope containing content, update time, and an
explicit base revision: a known saved revision, an absent saved file, or unknown.
The unversioned development format was never released and is not migrated. Malformed
versioned envelopes are invalid and are neither partially adopted nor silently treated as current.
