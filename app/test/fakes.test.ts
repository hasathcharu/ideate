import { describe, expect, it } from 'vitest'
import { deferred, FakeGitHubApi, FakeStorage } from './fakes'

describe('test boundary fakes', () => {
  it('settles competing requests in reverse order', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const settled: string[] = []
    void first.promise.then(value => settled.push(value))
    void second.promise.then(value => settled.push(value))
    second.resolve('second')
    await second.promise
    first.resolve('first')
    await first.promise
    expect(settled).toEqual(['second', 'first'])
  })

  it('keeps the original value when a storage write fails', () => {
    const storage = new FakeStorage()
    storage.setItem('draft', 'original')
    storage.failSet = true
    expect(() => storage.setItem('draft', 'replacement')).toThrow()
    expect(storage.getItem('draft')).toBe('original')
  })

  it('records GitHub call order and waits for a controlled response', async () => {
    const head = deferred<{ sha: string }>()
    const api = new FakeGitHubApi()
    api.queue('git.getRef', head.promise)
    const response = api.call<{ sha: string }>('git.getRef', { ref: 'heads/main' })
    expect(api.calls).toEqual([{ operation: 'git.getRef', args: { ref: 'heads/main' } }])
    head.resolve({ sha: 'abc' })
    await expect(response).resolves.toEqual({ data: { sha: 'abc' } })
  })
})
