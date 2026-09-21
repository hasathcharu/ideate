import { describe, expect, it } from 'vitest'
import { RequestGate, WorkspaceStore, documentKey, type DocumentIdentity } from './workspaceStore'

const file = (repo: string, branch: string): DocumentIdentity => ({
  workspace: { mode: 'github', owner: 'owner', repo, branch },
  path: 'same.mmd', kind: 'mermaid',
})

describe('WorkspaceStore', () => {
  it('keeps identical paths on different repositories and branches distinct', () => {
    const store = new WorkspaceStore()
    const main = file('one', 'main')
    const branch = file('one', 'feature')
    const other = file('two', 'main')
    store.edit(main, 'main edit')
    store.edit(branch, 'branch edit')
    store.edit(other, 'other edit')
    expect(new Set([documentKey(main), documentKey(branch), documentKey(other)]).size).toBe(3)
    expect(store.get(documentKey(main))?.content).toBe('main edit')
    expect(store.get(documentKey(branch))?.content).toBe('branch edit')
    expect(store.get(documentKey(other))?.content).toBe('other edit')
  })

  it('rejects an old open response after a different activation', () => {
    const store = new WorkspaceStore()
    const first = file('one', 'main')
    const second = file('two', 'main')
    const firstGeneration = store.activate(documentKey(first))
    const secondGeneration = store.activate(documentKey(second))
    expect(store.adopt(first, 'old', 'old', 'sha-old', firstGeneration)).toBe(false)
    expect(store.adopt(second, 'new', 'new', 'sha-new', secondGeneration)).toBe(true)
    expect(store.get(documentKey(first))).toBeUndefined()
    expect(store.get(documentKey(second))?.content).toBe('new')
  })

  it('settles a delayed single save into its original record and retains newer edits', async () => {
    const store = new WorkspaceStore()
    const first = file('one', 'main')
    const second = file('one', 'feature')
    store.activate(documentKey(first))
    const submitted = store.edit(first, 'submitted')
    store.edit(first, 'newer edit')
    store.activate(documentKey(second))
    store.edit(second, 'second document')
    await Promise.resolve()
    store.settleSave(first, submitted.content, 'sha-1', submitted.revision)
    expect(store.get(documentKey(first))).toMatchObject({
      content: 'newer edit', savedContent: 'submitted', savedRevision: 'sha-1',
      persistence: 'dirty',
    })
    expect(store.get(documentKey(second))?.content).toBe('second document')
  })

  it('marks an unchanged submitted revision clean after save', () => {
    const store = new WorkspaceStore()
    const identity = file('one', 'main')
    const submitted = store.edit(identity, 'saved')
    store.settleSave(identity, 'saved', 'sha-2', submitted.revision)
    expect(store.get(documentKey(identity))?.persistence).toBe('clean')
  })

  it('settles a delayed Save All into both original records after branch activation changes', async () => {
    const store = new WorkspaceStore()
    const first = file('one', 'main')
    const second: DocumentIdentity = { ...first, path: 'other.md', kind: 'markdown' }
    const branch = file('one', 'feature')
    const one = store.edit(first, 'one')
    const two = store.edit(second, 'two')
    let finish!: () => void
    const commit = new Promise<void>((resolve) => { finish = resolve })
    const completion = commit.then(() => {
      store.settleSave(first, one.content, 'sha-one', one.revision)
      store.settleSave(second, two.content, 'sha-two', two.revision)
    })
    store.activate(documentKey(branch))
    store.edit(branch, 'branch work')
    store.edit(first, 'later change')
    finish()
    await completion
    expect(store.get(documentKey(first))).toMatchObject({
      content: 'later change', savedContent: 'one', savedRevision: 'sha-one', persistence: 'dirty',
    })
    expect(store.get(documentKey(second))).toMatchObject({
      content: 'two', savedContent: 'two', savedRevision: 'sha-two', persistence: 'clean',
    })
    expect(store.get(documentKey(branch))?.content).toBe('branch work')
  })

  it('moves and forgets records without leaving a pending old path', () => {
    const store = new WorkspaceStore()
    const old = file('one', 'main')
    const renamed: DocumentIdentity = { ...old, path: 'renamed.mmd' }
    store.edit(old, '')
    store.move(old, renamed)
    expect(store.get(documentKey(old))).toBeUndefined()
    expect(store.get(documentKey(renamed))).toMatchObject({ content: '', exists: true })
    store.forget(renamed)
    expect(store.get(documentKey(renamed))).toBeUndefined()
  })
})

describe('RequestGate', () => {
  it.each(['file', 'tree', 'history'])('discards old %s results when promises finish out of order', async () => {
    const gate = new RequestGate()
    let releaseOld!: (value: string) => void
    let releaseNew!: (value: string) => void
    const oldPromise = new Promise<string>((resolve) => { releaseOld = resolve })
    const newPromise = new Promise<string>((resolve) => { releaseNew = resolve })
    const old = gate.begin('repo-one/main:history')
    const newer = gate.begin('repo-two/main:history')
    const adopted: string[] = []
    const oldCompletion = oldPromise.then((value) => {
      if (gate.accepts(old, 'repo-two/main:history')) adopted.push(value)
    })
    const newCompletion = newPromise.then((value) => {
      if (gate.accepts(newer, 'repo-two/main:history')) adopted.push(value)
    })
    releaseNew('new')
    await newCompletion
    releaseOld('old')
    await oldCompletion
    expect(adopted).toEqual(['new'])
  })

  it('invalidates an in-flight version when the selected history path changes', () => {
    const gate = new RequestGate()
    const old = gate.begin('repo/main:old-path')
    gate.invalidate()
    expect(gate.accepts(old, 'repo/main:old-path')).toBe(false)
  })
})
