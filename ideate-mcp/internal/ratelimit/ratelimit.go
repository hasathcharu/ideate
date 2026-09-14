// Package ratelimit is a per-key token bucket with an expiry sweep, used twice: once as a general
// per-IP limit on the two public routes, and once — much tighter — on requests that name a pairing
// code nobody holds.
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

// AllowDistinct takes one token for key, but only the first time key presents a given subject.
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

// leadingIP takes the first entry of a possibly comma-separated header and returns it only if it is
// an address.
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
func WithClientIP(ctx context.Context, ip string) context.Context {
	return context.WithValue(ctx, contextKey{}, ip)
}

// ClientIPFrom reads the address back, falling back to a shared bucket.
func ClientIPFrom(ctx context.Context) string {
	if ip, ok := ctx.Value(contextKey{}).(string); ok && ip != "" {
		return ip
	}
	return "unknown"
}
