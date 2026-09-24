import { describe, expect, it } from 'vitest'
import { forwardAuthCookies } from './authCookies'

describe('forwardAuthCookies', () => {
  it('passes a rotated token to the same request and keeps unrelated cookies', () => {
    const headers = new Headers({ cookie: 'theme=dark; authjs.session-token=old' })
    const result = forwardAuthCookies(headers, [
      'authjs.session-token=new; Path=/; HttpOnly; SameSite=Lax',
    ])

    expect(result.get('cookie')).toBe('theme=dark; authjs.session-token=new')
    expect(headers.get('cookie')).toBe('theme=dark; authjs.session-token=old')
  })

  it('replaces chunked tokens and removes cleared chunks', () => {
    const headers = new Headers({
      cookie: '__Secure-authjs.session-token.0=old0; __Secure-authjs.session-token.1=old1',
    })
    const result = forwardAuthCookies(headers, [
      '__Secure-authjs.session-token.0=new0; Path=/; HttpOnly',
      '__Secure-authjs.session-token.1=; Max-Age=0; Path=/; HttpOnly',
    ])

    expect(result.get('cookie')).toBe('__Secure-authjs.session-token.0=new0')
  })
})
