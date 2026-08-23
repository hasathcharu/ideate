# 0003. Every action takes a branch, and overwrite is never a force-push

**Status** accepted &nbsp;·&nbsp; **Touches** `app/app/actions/github.ts, app/components/BranchPicker.tsx, app/components/AppShell.tsx`

The invariants this record justifies are listed in [`CLAUDE.md`](../../CLAUDE.md). This file holds the reasoning behind them — read it before changing any of them, and update it here when a decision actually changes.

---

## Rule 4

**Every read/write server action takes a caller-supplied `branch`** — there
is no fixed branch constant. The selected `{owner, name, defaultBranch,
branch}` (`RepoRef`, `lib/types.ts`) lives in `AppConfig.repo`;
`BranchPicker.tsx` lists/creates branches (`listBranches`/`createBranch` in
`app/actions/github.ts`). "Open PR" is a plain redirect to GitHub's compare
URL (`compare/{defaultBranch}...{branch}`) — there is no PR-creation API
surface, and no server-side PR/merge logic of any kind.

## Rule 6

**Never expose a true force-push.** "Overwrite" on conflict = refetch the
latest sha, then commit on top of it (`onOverwrite` in `AppShell.tsx`). Do not
use the git data API to rewrite refs.
