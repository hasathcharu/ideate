/** Make Auth.js's refreshed session visible to the request behind the proxy. */
export function forwardAuthCookies(headers: Headers, setCookies: string[]): Headers {
  if (setCookies.length === 0) return headers

  const requestHeaders = new Headers(headers)
  const cookies = new Map<string, string>()
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const pair = part.trim()
    const equals = pair.indexOf('=')
    if (equals > 0) cookies.set(pair.slice(0, equals), pair.slice(equals + 1))
  }

  for (const setCookie of setCookies) {
    const pair = setCookie.split(';', 1)[0] ?? ''
    const equals = pair.indexOf('=')
    if (equals <= 0) continue
    const name = pair.slice(0, equals)
    const value = pair.slice(equals + 1)
    if (value && !/\bMax-Age=0\b/i.test(setCookie)) cookies.set(name, value)
    else cookies.delete(name)
  }

  requestHeaders.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '))
  return requestHeaders
}
