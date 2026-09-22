import { describe, expect, it } from 'vitest'
import { applyFilePatch, lineRange, parseUnifiedDiff, searchDocuments } from './agentWorkspace'

describe('agent workspace operations', () => {
  it('searches literal text with globs, context and revisions', () => {
    expect(searchDocuments([
      { path: 'docs/a.md', text: 'zero\nNeedle here\ntwo', revision: 4 },
      { path: 'other/b.md', text: 'needle elsewhere', revision: 2 },
    ], 'needle', { globs: ['docs/**'], contextLines: 1 })).toEqual({
      matches: [{ path: 'docs/a.md', line: 2, excerpt: '1: zero\n2: Needle here\n3: two', revision: 4 }],
      scannedBytes: 20,
      truncated: false,
    })
  })

  it('returns bounded line ranges', () => {
    expect(lineRange('one\ntwo\nthree', 2, 9)).toEqual({ text: 'two\nthree', startLine: 2, endLine: 3, lineCount: 3 })
  })

  it('applies multiple files and hunks without fuzzy relocation', () => {
    const files = parseUnifiedDiff(`diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -1,2 +1,2 @@
 one
-two
+TWO
--- /dev/null
+++ b/new.mmd
@@ -0,0 +1,2 @@
+flowchart LR
+  A --> B`)
    expect(files.map((file) => file.path)).toEqual(['a.md', 'new.mmd'])
    expect(applyFilePatch('one\ntwo\n', files[0]!)).toEqual({ text: 'one\nTWO\n', added: 1, deleted: 1 })
    expect(applyFilePatch('', files[1]!)).toEqual({ text: 'flowchart LR\n  A --> B\n', added: 2, deleted: 0 })
  })

  it('rejects deletes, renames and stale hunk context', () => {
    expect(() => parseUnifiedDiff('--- a/a.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-x')).toThrow('cannot delete')
    const patch = parseUnifiedDiff('--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-old\n+new')[0]!
    expect(() => applyFilePatch('changed', patch)).toThrow('does not match')
  })
})
