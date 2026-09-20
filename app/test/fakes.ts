/** Explicitly settle asynchronous operations in the order a test chooses. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** A Storage implementation with controllable quota/access failures. */
export class FakeStorage implements Storage {
  private readonly items = new Map<string, string>()
  failGet = false
  failSet = false
  failRemove = false

  get length() { return this.items.size }
  clear() { this.items.clear() }
  key(index: number) { return [...this.items.keys()][index] ?? null }
  getItem(key: string) {
    if (this.failGet) throw new DOMException('Storage unavailable', 'SecurityError')
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string) {
    if (this.failSet) throw new DOMException('Quota exceeded', 'QuotaExceededError')
    this.items.set(key, value)
  }
  removeItem(key: string) {
    if (this.failRemove) throw new DOMException('Storage unavailable', 'SecurityError')
    this.items.delete(key)
  }
}

/** Queue API responses so a test can place a GitHub head change between reads. */
export class FakeGitHubApi {
  readonly calls: Array<{ operation: string; args: unknown }> = []
  private readonly responses = new Map<string, Array<() => Promise<unknown>>>()

  queue<T>(operation: string, result: T | Promise<T>) {
    const pending = this.responses.get(operation) ?? []
    pending.push(() => Promise.resolve(result))
    this.responses.set(operation, pending)
  }

  async call<T>(operation: string, args: unknown): Promise<{ data: T }> {
    this.calls.push({ operation, args })
    const next = this.responses.get(operation)?.shift()
    if (!next) throw new Error(`No fake GitHub response for ${operation}`)
    return { data: await next() as T }
  }
}
