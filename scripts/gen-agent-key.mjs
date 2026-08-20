/**
 * Generate the Ed25519 keypair that signs agent-bridge connection tokens.
 *
 * Only the private half is configured: Ed25519's public key is derivable from it,
 * so one variable can't drift out of step with a second one. The public key is
 * served from `/api/agent/jwks`, which is how an MCP server on someone else's
 * laptop verifies a token without holding anything secret.
 *
 * Development doesn't need this — `lib/agentKey.server.ts` generates an ephemeral
 * key per server process when the variable is unset. Production does: the key has
 * to survive a deploy, or every connected agent breaks the moment one ships.
 */
import { generateKeyPairSync } from 'node:crypto'

const { privateKey } = generateKeyPairSync('ed25519')
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })

// Base64 the whole PEM block: it is multi-line and environment variables are
// not, so this is what makes it pastable into a deployment config.
const encoded = Buffer.from(pem, 'utf8').toString('base64')

process.stdout.write(
  [
    '',
    'Add this to .env.local (development) or your deployment environment:',
    '',
    `IDEATE_AGENT_PRIVATE_KEY=${encoded}`,
    '',
    'Keep it secret — it is what proves a connection token came from Ideate.',
    'Rotating it invalidates every token in flight, which is harmless: tokens live',
    'for 60 seconds and the tab mints a fresh one on its next reconnect.',
    '',
  ].join('\n'),
)
