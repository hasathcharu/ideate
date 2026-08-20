import { SignJWT } from 'jose'
import { getAgentSigningKey } from '@/lib/agentKey.server'
import { TOKEN_AUDIENCE } from '@/lib/agentProtocol'

/**
 * Mints the short-lived token an Agent Link tab presents to the MCP server on the
 * user's own machine.
 *
 * **The security of this endpoint is the absence of CORS headers, not the
 * signature.** A signature only proves "Ideate minted this"; what makes it mean
 * "this really is an Ideate tab" is that nobody else can *read* the response.
 * WebSockets have no same-origin policy — any page can open one to
 * `ws://127.0.0.1:7391` — but `fetch` does, so a cross-origin caller can send
 * this request and still never see the body. That launders the connection through
 * a channel where the same-origin policy applies, and carries the proof into the
 * channel where it does not.
 *
 * So: never add `Access-Control-Allow-Origin` here. Doing so would hand every
 * page on the internet the ability to drive the user's editor.
 *
 * Deliberately unauthenticated. The token proves "an Ideate page", not "a
 * signed-in user" — which is what lets the bridge work in `?mode=local` — and it
 * grants no server-side capability whatsoever: the only thing it opens is a
 * socket on the caller's *own* loopback interface.
 */

/** Short enough that a captured token is near worthless, long enough to survive
 *  a slow connect. Re-minted on every reconnect rather than cached. */
const TTL_SECONDS = 60

export async function GET(request: Request): Promise<Response> {
  // Fetch Metadata as defence in depth. A browser sets this and page JS cannot
  // forge it, so a cross-site caller is refused before anything is signed. It is
  // absent for non-browser clients (and trivially spoofable by a local process),
  // which is why its absence is allowed rather than treated as suspicious — the
  // no-CORS property above is what actually holds the line.
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin') {
    return refuse('Cross-site token requests are not allowed.')
  }

  const issuer = originOf(request)

  let token: string
  try {
    const { privateKey, kid } = await getAgentSigningKey()
    token = await new SignJWT({})
      .setProtectedHeader({ alg: 'Ed25519', kid })
      .setIssuer(issuer)
      .setAudience(TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${TTL_SECONDS}s`)
      .setJti(crypto.randomUUID())
      .sign(privateKey)
  } catch (error) {
    // A missing signing key in production is a deployment fault, and the message
    // says exactly which variable to set — worth surfacing rather than a bare 500.
    const message = error instanceof Error ? error.message : 'Could not mint a token.'
    return Response.json({ error: message }, { status: 500, headers: noStore() })
  }

  return Response.json({ token, issuer, expiresIn: TTL_SECONDS }, { headers: noStore() })
}

function refuse(message: string): Response {
  return Response.json({ error: message }, { status: 403, headers: noStore() })
}

/** `no-store` matters more than usual: a cached token would be served past its
 *  own expiry and, worse, shared between visitors by any intermediary. */
function noStore(): HeadersInit {
  return { 'Cache-Control': 'no-store, private', Vary: 'Origin' }
}

/**
 * The public origin of this deployment, which becomes the token's `iss` — and so
 * the origin an MCP server resolves the JWKS from and matches against its pinned
 * list. `request.url` is the *internal* URL behind a proxy (http, and possibly an
 * internal host), so the forwarded headers are what give the browser-visible
 * origin.
 */
function originOf(request: Request): string {
  const url = new URL(request.url)
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host
  const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
  // A comma-separated chain can arrive through several proxies; the first entry
  // is the one the browser actually spoke to.
  const firstHost = host.split(',')[0]!.trim()
  const firstProto = proto.split(',')[0]!.trim()
  return `${firstProto}://${firstHost}`
}
