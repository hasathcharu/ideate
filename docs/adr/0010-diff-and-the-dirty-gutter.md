# 0010. Uncommitted changes are shown as a diff, computed locally

**Status** accepted &nbsp;·&nbsp; **Touches** `app/lib/diff.ts, app/components/DiffView.tsx, app/components/Editor.tsx`

The invariants this record justifies are listed in [`CLAUDE.md`](../../CLAUDE.md). This file holds the reasoning behind them — read it before changing any of them, and update it here when a decision actually changes.

---

## Uncommitted changes are shown as a diff

`lib/diff.ts` is a Myers line diff (what git uses), with a common prefix/suffix
trim first and a size cap after it — past `MAX_DIFF_LINES` the result degrades to
"all of the old, then all of the new" rather than spending seconds and hundreds of
megabytes proving that two large files are unrelated. **No GitHub call is
involved**: the app already holds the committed content it loaded (`baseline`)
beside the working copy, so a diff of the open document is pure computation.

It feeds three surfaces:

- **The editor's dirty gutter** — a bar beside the line numbers, VS Code style
  (`lineChanges`). The unit is a *block* of adjacent changed lines, not a line:
  removals and additions together are a **modification**, additions alone are an
  **addition**, and removals alone have no line in the working copy to mark, so
  they mark the line that now sits where they were. The map is computed in React
  and pushed into CodeMirror as a `StateEffect`, because the baseline is the
  *app's* state — it changes on commit, restore and file switch, none of which are
  document changes the editor would otherwise see. The gutter is empty when
  `loadedSha === null`: a file with no commit behind it has nothing to diverge
  from, and marking every line green is noise.
- **A peek popup** on clicking a marker (`changeAtLine`), positioned from
  `coordsAtPos` and re-pinned on scroll. The gutter's `mousedown` handler returns
  `true` so the click doesn't also move the cursor, and the marker widens with a
  `scaleX` on hover — a real width change would reflow the gutters beside it. The
  popup's **Revert** discards that one block: every kind of change is reduced to a
  single `LineChangeRevert` ("replace these lines with this text") in `lib/diff.ts`,
  so `applyRevert` in the editor has one operation to perform rather than three
  cases to re-derive. Its two line-break subtleties are invisible in the line range
  and easy to lose: deleting lines has to take a line break with them, and
  inserting at the end of the document puts the break *before* the text. It goes
  through `dispatch`, so ⌘Z undoes it like any edit.
- **`components/DiffView.tsx`** — side-by-side (default) or unified, from the same
  hunks. Used by the editor's diff toggle (committed vs. working copy, taking the
  whole pane row) and by version history's Preview/Diff toggle, which compares the
  selected version either with the one before it or with the working copy.

Scenes are excluded everywhere: a `.excalidraw` file is JSON whose bytes churn
without the drawing changing (rule 9), so a line diff of one shows changes that
aren't there.

In version history, "previous version" is the next commit in the **loaded** page.
"No older commit here" is ambiguous — first commit of the path, or next page not
fetched yet — so the fetch effect only claims the file was created in this commit
when there is genuinely nothing more to page in; otherwise it asks the user to
load more history.
