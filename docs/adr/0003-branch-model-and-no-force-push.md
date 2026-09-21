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

Because the commit is atomic, its conflict answer has to be too: capture the
branch head first, then check every path's current blob sha at that immutable
commit **before** anything is written. Any mismatch
refuses the whole batch and names the paths. "These three landed and that one
didn't" is not a state this can produce, so reporting it would be a lie the user
then has to untangle. It is deliberately not routed to `ConflictModal`, whose two
choices act on the *open* file — which is usually not the file that went stale.

The client supplies each file's sha. A dirty draft records the saved SHA on which
its first edit was based. Before a single save or Save All, that base must match
the current saved revision. A legacy, damaged, or otherwise unknown draft base is
an explicit reconciliation state and is never relabelled with the current SHA.
The user may either discard the draft for the latest GitHub content or deliberately
commit it on top of the latest revision. A competing branch update after the head is
captured makes the non-forced ref advance fail; it cannot silently become the
parent of stale content.

Rename uses the same snapshot and commit path. It reads the source blob and
checks that the destination is absent at the captured commit. Any destination
entry is a conflict; a rejected rename leaves both paths untouched.

A branch without an initial commit has no Git tree to use as a base. Save All
and rename return a conflict explaining that the branch must first be
initialized on GitHub. The same answer applies if the selected branch ref has
disappeared; these actions do not create an initial branch or commit.

## Rule 6

**Never expose a true force-push.** "Overwrite" on conflict = refetch the
latest sha, then commit on top of it (`onOverwrite` in `AppShell.tsx`). Do not
force-update refs or replace branch history. Normal ref advancement with
`force: false` is allowed.
