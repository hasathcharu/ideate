# 0003. Explicit branches and refs, and overwrite is never a force-push

**Status** accepted &nbsp;·&nbsp; **Touches** `app/app/actions/github.ts, app/components/BranchPicker.tsx, app/components/AppShell.tsx`

[`AGENTS.md`](../../AGENTS.md) states repository-wide boundaries and required reading. This record defines the detailed subsystem contracts and their reasoning. Read it before modifying this subsystem, and update it when a decision changes.

---

## Rule 4

**Operations on current branch content take a caller-supplied `branch`.** History
reads take an explicit `ref`. Repository and session metadata operations do not
need a branch. There is no fixed branch constant. The selected `{owner, name, defaultBranch,
branch}` (`RepoRef`, `lib/types.ts`) lives in `AppConfig.repo`;
`BranchPicker.tsx` lists/creates branches (`listBranches`/`createBranch` in
`app/actions/github.ts`). "Open PR" is a plain redirect to GitHub's compare
URL (`compare/{defaultBranch}...{branch}`) — there is no PR-creation API
surface, and no server-side PR/merge logic of any kind.

### Save All is one commit

Saving several changed files has to produce **one** commit, so `commitFiles`
builds a single tree and a single commit and fast-forwards the ref with
`force: false` — the same shape `renameFile` uses, and a normal ref advance
rather than the ref rewrite rule 6 forbids. Looping `commitFile` would put the
same bytes on the branch as a run of unrelated commits, most of them describing a
state the user never had on screen and none of them revertable as the one change
it actually was.

Because the commit is atomic, its conflict answer has to be too: every path's
current blob sha is checked **before** anything is written, and any mismatch
refuses the whole batch and names the paths. "These three landed and that one
didn't" is not a state this can produce, so reporting it would be a lie the user
then has to untangle. It is deliberately not routed to `ConflictModal`, whose two
choices act on the *open* file — which is usually not the file that went stale.

The client supplies each file's sha, and holds only one of them: the open file's.
For every other dirty path it reads the saved file immediately before committing,
which is exactly the read `openFile` would do if the user had clicked it — the app
genuinely has no record of what a background edit was based on, so this is no
weaker than the path it replaces. Anything landing between that read and the
commit is still caught server-side.

## Rule 6

**Never expose a true force-push.** "Overwrite" on conflict = refetch the
latest sha, then commit on top of it (`onOverwrite` in `AppShell.tsx`). Do not
force-update refs or replace branch history. Normal ref advancement with
`force: false` is allowed.
