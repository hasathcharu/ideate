import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose'
import { JWKS_PATH, TOKEN_AUDIENCE } from '../lib/agentProtocol.js'

/**
 * Verifying the connection token a tab presents.
 *
 * The signature is not what makes this safe — what makes it safe is that a token
 * can only be *obtained* from an Ideate origin over a `fetch`, which unlike a
 * WebSocket is bound by the same-origin policy. This module's job is to make sure
 * the token really came from an origin we trust, and to make sure it cannot be
 * used twice.
 *
 * The load-bearing rule is below: **`iss` is checked against a pinned list before
 * any JWKS is fetched.** Trusting `iss` and fetching the key it names would verify
 * happily against a hostile deployment that signs with its own key and publishes a
 * matching JWKS — the check would look like it was doing something while proving
 * nothing at all.
 */

/** Every issuer trusted out of the box. Overridable via `IDEATE_TRUSTED_ISSUERS`
 *  for a self-hosted deployment; adding one means that site can drive this
 *  machine's editor. */
export const DEFAULT_ISSUERS = ['https://ideate.haru.lk', 'http://localhost:3000'] as const

/** Ed25519 only. Left open, a token could arrive signed with whatever algorithm
 *  its author preferred — including, historically, `none`. */
const ALGORITHMS = ['Ed25519']

/** Tolerance for a laptop's clock drifting from the server's. A 60-second token
 *  is unusable with none at all. */
const CLOCK_TOLERANCE_SECONDS = 30

/**
 * One key set per issuer.
 *
 * `createRemoteJWKSet` is what absorbs key rotation: when a token's `kid` matches
 * nothing it holds, it refetches (rate-limited by `cooldownDuration`). That is not
 * a nicety — in development the app generates a fresh keypair per server process,
 * so every `next dev` restart rotates the key under a running MCP process, and
 * without the refetch this server would reject every token until it too was
 * restarted.
 */
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function keySetFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let set = keySets.get(issuer)
  if (!set) {
    set = createRemoteJWKSet(new URL(`${issuer}${JWKS_PATH}`), {
      cooldownDuration: 5_000,
      cacheMaxAge: 60_000,
    })
    keySets.set(issuer, set)
  }
  return set
}

/**
 * Tokens already spent, by `jti`, with the expiry they carried.
 *
 * Without this, a token captured once could be replayed for the rest of its 60
 * seconds. Entries are dropped as they expire, so the map stays the size of one
 * TTL's worth of connections — which for a bridge that holds one tab at a time is
 * a handful.
 */
const spent = new Map<string, number>()

function rememberJti(jti: string, expiresAtMs: number): void {
  const now = Date.now()
  for (const [id, expiry] of spent) if (expiry <= now) spent.delete(id)
  spent.set(jti, expiresAtMs)
}

export interface VerifiedToken {
  issuer: string
}

/**
 * Verify `token`, or throw with a message the tab can show the user.
 *
 * Messages are deliberately specific about *which* check failed — a bridge that
 * only ever says "unauthorized" is undebuggable, and none of these distinctions
 * help an attacker who already has to mint a signature to get past the first one.
 */
export async function verifyConnectionToken(
  token: string,
  issuers: readonly string[],
): Promise<VerifiedToken> {
  // Unverified read, purely to learn which issuer to trust. Nothing from here is
  // used for anything else.
  let claimedIssuer: string | undefined
  try {
    claimedIssuer = decodeJwt(token).iss
  } catch {
    throw new Error('The connection token is not a well-formed JWT.')
  }
  if (!claimedIssuer) {
    throw new Error('The connection token names no issuer.')
  }
  if (!issuers.includes(claimedIssuer)) {
    throw new Error(
      `Untrusted token issuer "${claimedIssuer}". Trusted issuers are: ${issuers.join(', ')}. ` +
        'Set IDEATE_TRUSTED_ISSUERS if this Ideate deployment is yours.',
    )
  }

  let payload
  try {
    ;({ payload } = await jwtVerify(token, keySetFor(claimedIssuer), {
      issuer: claimedIssuer,
      audience: TOKEN_AUDIENCE,
      algorithms: ALGORITHMS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    }))
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'verification failed'
    throw new Error(`The connection token did not verify against ${claimedIssuer}: ${reason}`)
  }

  const { jti, exp } = payload
  if (!jti) {
    // Without a unique id there is nothing to remember, so replay protection
    // would silently not exist.
    throw new Error('The connection token carries no jti, so it cannot be replay-checked.')
  }
  if (spent.has(jti)) {
    throw new Error('That connection token has already been used. Tokens are single-use.')
  }
  rememberJti(jti, exp ? exp * 1000 : Date.now() + 60_000)

  return { issuer: claimedIssuer }
}
