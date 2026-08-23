// Package ratelimit is a per-key token bucket with an expiry sweep, used twice:
// once as a general per-IP limit on the two public routes, and once — much
// tighter — on requests that name a pairing code nobody holds.
//
// The split matters because the two guard different things. The general limit is
// ordinary abuse control. The unknown-code limit is what makes an 8-character code
// a credential: 2^40 of Crockford base32 is only out of reach if guesses are
// rationed, and a guess is exactly what an unknown code looks like.
//
// It has to be per-IP rather than per-code, and that is forced rather than chosen.
// The code arrives as a *tool argument*, so it cannot be read until the MCP request
// body has been parsed — by which point the work the limiter exists to prevent has
// already been done. So the limiter sits in front of the body, keyed on the only
// thing available that early.
package ratelimit

import (
	"context"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Limiter rations by key. The zero value is not usable; call New.
type Limiter struct {
	limit rate.Limit
	burst int
	// ttl drops a key that has gone quiet for long enough to have refilled
	// completely, so the map stays the size of current traffic rather than of all
	// traffic ever seen. Dropping a full bucket loses nothing.
	ttl time.Duration

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	limiter *rate.Limiter
	seen    time.Time
	// charged is what this key has already paid a token for, oldest first. Only
	// AllowDistinct uses it; see there for why repeats are free.
	charged []string
}

// maxDistinctSubjects bounds one key's memory of what it has paid for.
//
// It cannot grow to the number of subjects a caller *tries*, because that is
// attacker-controlled — and it does not need to: a caller who gets past the rate
// itself is presenting a handful of subjects, not thousands. Evicting the oldest
// entry makes a very old subject chargeable again, which costs one token.
const maxDistinctSubjects = 32

// New builds a limiter allowing `perSecond` sustained with room for `burst`.
func New(perSecond float64, burst int) *Limiter {
	ttl := 10 * time.Minute
	if perSecond > 0 {
		// However long a fully-drained bucket needs to refill, with a floor so a
		// generous limit does not get an absurdly short TTL.
		refill := time.Duration(float64(burst)/perSecond) * time.Second
		if refill > ttl {
			ttl = refill
		}
	}
	return &Limiter{
		limit:   rate.Limit(perSecond),
		burst:   burst,
		ttl:     ttl,
		buckets: make(map[string]*bucket),
	}
}

// Allow takes one token for key, reporting whether there was one.
func (l *Limiter) Allow(key string) bool {
	now := time.Now()
	l.mu.Lock()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{limiter: rate.NewLimiter(l.limit, l.burst)}
		l.buckets[key] = b
	}
	b.seen = now
	limiter := b.limiter
	l.mu.Unlock()
	return limiter.Allow()
}

// AllowDistinct takes one token for key, but only the first time key presents a
// given subject. A repeat is free.
//
// "How many unknown codes has this address tried" and "how many requests has it
// sent" are different questions, and only the first one is a guess. A brute-force
// attempt presents a distinct code every time and pays for each; an agent left
// holding a code the human regenerated presents the *same* one forever and pays
// once.
//
// The distinction is what makes the tight limiter survive NAT. A company shares one
// public address, so it shares one bucket — and charging repeats meant one
// colleague's stale code could drain the burst and ration everybody else's *first*
// attempt, which is indistinguishable from the service being broken. Note that a
// stale code is ordinary traffic here, not an error: every Regenerate, every closed
// tab, and every reload past TAB_GRACE leaves some agent holding one.
//
// A refusal is deliberately **not** remembered, so a subject that could not be paid
// for stays chargeable — otherwise a guess refused once would be free ever after.
func (l *Limiter) AllowDistinct(key, subject string) bool {
	now := time.Now()
	// The lock is held across the take, unlike Allow: checking and recording have to
	// be one step, or two concurrent requests carrying the same stale code are both
	// charged for it.
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{limiter: rate.NewLimiter(l.limit, l.burst)}
		l.buckets[key] = b
	}
	b.seen = now
	if slices.Contains(b.charged, subject) {
		return true
	}
	if !b.limiter.Allow() {
		return false
	}
	b.charged = append(b.charged, subject)
	if len(b.charged) > maxDistinctSubjects {
		b.charged = b.charged[len(b.charged)-maxDistinctSubjects:]
	}
	return true
}

// Sweep drops keys idle for longer than the TTL. Call it on a ticker; without it
// the map is an unbounded record of every client that ever connected.
func (l *Limiter) Sweep() {
	cutoff := time.Now().Add(-l.ttl)
	l.mu.Lock()
	defer l.mu.Unlock()
	for key, b := range l.buckets {
		if b.seen.Before(cutoff) {
			delete(l.buckets, key)
		}
	}
}

// Tracked is the number of keys currently held. Diagnostics only.
func (l *Limiter) Tracked() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// ClientIP is the address a request is rationed against.
//
// The order of the headers is the whole of the security here, and it is ordered by
// who is able to write each one rather than by convention:
//
//   - CF-Connecting-IP is written by Cloudflare's edge, which *overwrites* any
//     value the caller sent. It holds exactly one address, so there is no chain to
//     choose from and nothing a client can prepend.
//   - X-Forwarded-For is the generic fallback, and its left-most entry is the
//     client only when the nearest proxy *replaces* the header. Cloudflare and
//     nginx both **append** instead, so a caller who sends their own
//     X-Forwarded-For keeps the left-most slot and can rotate it per request —
//     which is exactly the bypass this ordering exists to close, and the reason
//     X-Forwarded-For may not be consulted while a CF header is present.
//
// Either header is forgeable by anyone who reaches the service *directly*, so a
// deployment behind Cloudflare should also refuse connections from outside
// Cloudflare's ranges. Worth being clear-eyed about: this limiter is not what stops
// a code-guessing attack from succeeding — the size of the code is — it is what
// stops one from being cheap.
func ClientIP(r *http.Request) string {
	for _, header := range []string{"CF-Connecting-IP", "X-Forwarded-For", "X-Real-IP"} {
		if ip := leadingIP(r.Header.Get(header)); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// leadingIP takes the first entry of a possibly comma-separated header and returns
// it only if it is an address.
//
// Validating rather than trusting is what keeps an unparseable header from
// shadowing a real RemoteAddr — a caller sending "X-Forwarded-For: nonsense" would
// otherwise be rationed under the key "nonsense", which is one bucket per string
// they care to invent. It cannot stop a caller inventing valid addresses instead;
// that is the direct-access case above.
func leadingIP(header string) string {
	first := strings.TrimSpace(strings.Split(header, ",")[0])
	if first == "" {
		return ""
	}
	if net.ParseIP(first) != nil {
		return first
	}
	// Some proxies write host:port. Salvage the host, since dropping to RemoteAddr
	// there would ration every client behind that proxy as one.
	if host, _, err := net.SplitHostPort(first); err == nil && net.ParseIP(host) != nil {
		return host
	}
	return ""
}

/* ------------------------------------------------------------------ */
/* Carrying the client's address past the HTTP layer                   */
/* ------------------------------------------------------------------ */

type contextKey struct{}

// WithClientIP stashes the caller's address on the request context.
//
// The unknown-code limiter has to run inside an MCP *tool handler* — that is the
// first point at which anyone knows the code was unknown — and by then the only
// thing left of the HTTP request is its context. So the address is put there by the
// middleware that already computed it, rather than recomputed from a request the
// tool layer would otherwise have to be handed.
func WithClientIP(ctx context.Context, ip string) context.Context {
	return context.WithValue(ctx, contextKey{}, ip)
}

// ClientIPFrom reads the address back, falling back to a shared bucket.
//
// The fallback is deliberately one bucket for everyone rather than "unlimited":
// an address the middleware could not determine is the case where rationing
// matters most, and lumping those callers together rations them jointly rather
// than letting them through.
func ClientIPFrom(ctx context.Context) string {
	if ip, ok := ctx.Value(contextKey{}).(string); ok && ip != "" {
		return ip
	}
	return "unknown"
}
