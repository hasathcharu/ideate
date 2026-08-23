import { TAB_PATH } from './agentProtocol'

/**
 * The one rule about where Agent Link's service may live: TLS, or unmistakably
 * local.
 *
 * This is a security control, so it exists once here and is **mirrored in Go**
 * (`ideate-mcp/internal/config.ValidateMCPOrigin`, with the same cases in its
 * test). The two copies guard different people: this one protects whoever is typing
 * into the Advanced options field from a typo, and the service's own protects its
 * operator from advertising a plaintext service and finding out from their users.
 * Plaintext anywhere but loopback means the pairing code — and every document the
 * tab is asked to read — crosses the network in the clear.
 *
 * The loopback exemption is deliberately narrow: the host *and* the one port.
 * `http://localhost:<anything>` would quietly re-admit a plaintext proxy on 80.
 */

/** The only port on which a plaintext service origin is allowed.
 *
 *  7391 is the old loopback bridge port. It means nothing to the protocol any more,
 *  but it is the number in every older README and in muscle memory, and reusing it
 *  for "a service you run yourself" costs nothing and saves an explanation. */
export const LOCAL_MCP_PORT = '7391'

/**
 * Returns a message explaining why `raw` is unusable, or `null` if it is fine.
 *
 * A message rather than a boolean because this feeds a form field, and "invalid"
 * on its own does not tell someone who pasted `https://mcp.example.com/mcp`
 * that the problem is the path.
 */
export function validateMcpOrigin(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return 'Enter a service URL, or reset to the default.'

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'That is not a URL. It should look like https://mcp.example.com.'
  }

  // An origin, not a URL. Silently ignoring a path would leave someone who pasted
  // the MCP endpoint wondering why their edit did nothing.
  if (url.pathname !== '/' && url.pathname !== '') {
    return 'Drop the path — this is just the service origin, like https://mcp.example.com.'
  }
  if (url.search || url.hash) {
    return 'Drop the query and fragment — this is just the service origin.'
  }
  if (!url.hostname) return 'That URL names no host.'

  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:') {
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (local && url.port === LOCAL_MCP_PORT) return null
    return (
      `Use https. Plain http is allowed only for a service you run yourself, on ` +
      `http://localhost:${LOCAL_MCP_PORT}.`
    )
  }
  return 'Use https (or http on localhost for a service you run yourself).'
}

/** Trailing-slash-free form, so two spellings of one origin never disagree. */
export function normalizeMcpOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/**
 * The WebSocket URL the tab dials.
 *
 * Derived from the origin rather than configured, so there is one field to get
 * wrong instead of two — and the scheme is derived too, because `wss` on an `https`
 * origin is not a choice anybody should be asked to make.
 */
export function mcpTabUrl(origin: string): string {
  const base = normalizeMcpOrigin(origin)
  const scheme = base.startsWith('https://') ? 'wss://' : 'ws://'
  return scheme + base.replace(/^https?:\/\//, '') + TAB_PATH
}
