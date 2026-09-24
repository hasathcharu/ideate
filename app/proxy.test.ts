import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { NextFetchEvent } from 'next/server'

vi.mock('@/auth', () => ({
  auth: async (request: unknown) => {
    if (typeof request === 'function') return async () => new Response()
    const headers = new Headers()
    headers.append('set-cookie', 'authjs.session-token=new; Path=/; HttpOnly')
    return new Response(null, { headers })
  },
}))

import { proxy } from './proxy'

describe('proxy', () => {
  it('returns the refreshed cookie and gives it to the current request', async () => {
    const request = new NextRequest('https://example.com/editor', {
      headers: { cookie: 'authjs.session-token=expired; theme=dark' },
    })
    const response = await proxy(request, {} as NextFetchEvent)

    expect(response.headers.get('x-middleware-request-cookie')).toBe(
      'authjs.session-token=new; theme=dark',
    )
    expect(response.headers.getSetCookie()).toEqual([
      'authjs.session-token=new; Path=/; HttpOnly',
    ])
  })
})
