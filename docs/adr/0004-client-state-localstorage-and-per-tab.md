# 0004. What may live in localStorage, and what must be per-tab

**Status** accepted &nbsp;·&nbsp; **Touches** `app/lib/types.ts, app/lib/agentLink.ts, app/lib/mcpOrigin.ts`

[`AGENTS.md`](../../AGENTS.md) states repository-wide boundaries and required reading. This record defines the detailed subsystem contracts and their reasoning. Read it before modifying this subsystem, and update it when a decision changes.

---

## Rule 3

**localStorage stores only** local-mode saved files (`km:file:`), uncommitted editor drafts, and app config
(selected repo, active theme, export prefs, scratch-document kind, editor
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
Moves check the destination and write it before deleting the source. A failed
copy leaves the source in place; a failed source deletion may leave two copies,
which is recoverable and reported to the caller. The per-tab Agent Link state
remains separate from these document records.

`WorkspaceStore` is the in-memory owner for working document revisions and save
settlement. Its keys include full workspace identity so equal paths in two
repositories or branches are separate records. Storage is still synchronous
localStorage in this stage; the asynchronous IndexedDB migration is planned after
shared document commands are in place.
