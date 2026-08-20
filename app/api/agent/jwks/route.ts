import { getAgentSigningKey } from '@/lib/agentKey.server'

/**
 * The public half of the agent-bridge signing key, so an MCP server on any
 * machine can verify a connection token without holding a shared secret.
 *
 * This one *is* safe to read from anywhere — it is a public key, and JWKS
 * endpoints are conventionally open — so unlike the token route it carries
 * `Access-Control-Allow-Origin: *`. An MCP process is not a browser and doesn't
 * need that header, but a browser-based debugging tool does, and there is nothing
 * here to protect.
 *
 * Cached briefly rather than indefinitely: in dev the key is generated per server
 * process (see `lib/agentKey.server.ts`), so a restart rotates it. Verifiers key
 * their cache on the `kid` in the token header and refetch on a miss, which is the
 * mechanism that actually absorbs rotation — this TTL just keeps them from
 * hammering the endpoint.
 */
export async function GET(): Promise<Response> {
  let jwk
  let kid: string
  try {
    const key = await getAgentSigningKey()
    jwk = key.publicJwk
    kid = key.kid
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No signing key configured.'
    return Response.json({ error: message }, { status: 500 })
  }

  return Response.json(
    { keys: [{ ...jwk, kid, alg: 'Ed25519', use: 'sig' }] },
    {
      headers: {
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
      },
    },
  )
}
