import 'server-only'

import { generateKeyPair, importPKCS8, exportJWK, calculateJwkThumbprint } from 'jose'
import type { CryptoKey, JWK } from 'jose'

/**
 * The Ed25519 keypair that signs Agent Link connection tokens.
 *
 * Server-only, like `lib/session.server.ts`: the private key must never reach the
 * browser by any route — not the `session` callback, not a client prop (CLAUDE.md
 * rule 2 applies to it for the same reason it applies to the GitHub token).
 *
 * Asymmetric on purpose. The verifier is an MCP process on the *user's laptop*,
 * so a symmetric secret would have to be copied there — which for the deployed
 * app means handing every user the production signing secret. Instead the public
 * half is published at `JWKS_PATH` and anyone can verify without holding anything
 * sensitive.
 */

const ALG = 'Ed25519'
const ENV_KEY = 'IDEATE_AGENT_PRIVATE_KEY'

export interface AgentSigningKey {
  privateKey: CryptoKey
  publicJwk: JWK
  /** JWK thumbprint. Travels in the JWT header so a verifier that has cached the
   *  wrong key knows to refetch, which is what keeps a dev-server restart (and
   *  its fresh ephemeral key) from wedging a running MCP process. */
  kid: string
}

/**
 * Cached on `globalThis` rather than at module scope. In dev, Next re-evaluates
 * server modules on hot reload, and a per-evaluation keypair would rotate the
 * signing key under a tab that is mid-session — the JWKS endpoint and the token
 * route would then disagree with each other, which reads as a broken signature
 * rather than as the reload it actually is.
 */
declare global {
  // eslint-disable-next-line no-var
  var __ideateAgentKey: Promise<AgentSigningKey> | undefined
}

async function resolve(): Promise<AgentSigningKey> {
  const encoded = process.env[ENV_KEY]

  if (!encoded) {
    // Production must have a stable key: it has to survive a deploy, or every
    // agent connected to the deployed app breaks the moment it ships. Failing
    // loudly here is much better than minting tokens nobody can verify.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `${ENV_KEY} is not set. Agent Link needs a stable signing key in ` +
          `production — generate one with \`npm run gen:agent-key\` and set it in the ` +
          `deployment environment.`,
      )
    }
    // In dev, generate one per server process. Local setup then needs no key
    // step at all, at the cost of rotating on restart — which the `kid` refetch
    // on the verifier side is there to absorb.
    const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: false })
    const publicJwk = await exportJWK(publicKey)
    return { privateKey, publicJwk, kid: await calculateJwkThumbprint(publicJwk) }
  }

  // Base64 of the PKCS#8 PEM. PEM is multi-line and environment variables are
  // not, so the wrapping is what makes this pastable into a deployment config.
  let pem: string
  try {
    pem = Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    throw new Error(`${ENV_KEY} is not valid base64. Regenerate it with \`npm run gen:agent-key\`.`)
  }
  if (!pem.includes('BEGIN PRIVATE KEY')) {
    throw new Error(
      `${ENV_KEY} does not decode to a PKCS#8 PEM private key. It should be the ` +
        `base64 of the whole \`-----BEGIN PRIVATE KEY-----\` block.`,
    )
  }

  const privateKey = await importPKCS8(pem, ALG)
  // Ed25519's public key is derivable from the private one, so only the private
  // half is configured — one env var instead of two that can drift apart.
  const publicJwk = await derivePublicJwk(pem)
  return { privateKey, publicJwk, kid: await calculateJwkThumbprint(publicJwk) }
}

/**
 * The public JWK for a PKCS#8 Ed25519 private key. `importPKCS8` yields a
 * non-extractable private `CryptoKey`, and there is no "give me the public half"
 * on the WebCrypto key object — so go back to node's own key API, which can walk
 * PEM → public key → JWK.
 */
async function derivePublicJwk(pem: string): Promise<JWK> {
  const { createPrivateKey, createPublicKey } = await import('node:crypto')
  const jwk = createPublicKey(createPrivateKey(pem)).export({ format: 'jwk' })
  return jwk as JWK
}

export function getAgentSigningKey(): Promise<AgentSigningKey> {
  globalThis.__ideateAgentKey ??= resolve()
  return globalThis.__ideateAgentKey
}
