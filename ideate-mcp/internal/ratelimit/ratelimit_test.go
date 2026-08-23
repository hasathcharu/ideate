package ratelimit

import (
	"net/http"
	"strconv"
	"testing"
)

// The precedence rule, and the bypass it exists to close.
//
// Cloudflare *appends* the client address to an X-Forwarded-For the caller sent
// rather than replacing the header, so the left-most entry belongs to whoever sent
// the request. Taking it while a CF header was present let one caller present a
// fresh key on every request, which turns the per-IP bucket on /mcp — the thing
// that makes an 8-character code a credential — into no limit at all.
func TestClientIPPrefersCloudflareHeader(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		remote  string
		want    string
	}{
		{
			name:    "spoofed X-Forwarded-For loses to the edge header",
			headers: map[string]string{"CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "198.51.100.1, 203.0.113.7"},
			remote:  "172.71.0.1:41000",
			want:    "203.0.113.7",
		},
		{
			name:    "X-Forwarded-For still serves a plain reverse proxy",
			headers: map[string]string{"X-Forwarded-For": "198.51.100.1, 10.0.0.2"},
			remote:  "10.0.0.2:41000",
			want:    "198.51.100.1",
		},
		{
			name:    "X-Real-IP is the last header consulted",
			headers: map[string]string{"X-Real-IP": "198.51.100.9"},
			remote:  "10.0.0.2:41000",
			want:    "198.51.100.9",
		},
		{
			name:   "no headers at all falls back to the peer",
			remote: "198.51.100.4:41000",
			want:   "198.51.100.4",
		},
		{
			// Otherwise a caller rations themselves under any string they invent.
			name:    "an unparseable header is skipped rather than used as a key",
			headers: map[string]string{"CF-Connecting-IP": "nonsense", "X-Forwarded-For": "also-nonsense"},
			remote:  "198.51.100.5:41000",
			want:    "198.51.100.5",
		},
		{
			// Dropping to RemoteAddr here would ration everyone behind that proxy
			// as a single client.
			name:    "host:port in a header keeps the host",
			headers: map[string]string{"X-Forwarded-For": "198.51.100.6:53124"},
			remote:  "10.0.0.2:41000",
			want:    "198.51.100.6",
		},
		{
			name:    "IPv6 survives intact",
			headers: map[string]string{"CF-Connecting-IP": "2001:db8::1"},
			remote:  "[2001:db8::2]:41000",
			want:    "2001:db8::1",
		},
		{
			name:   "a bracketed IPv6 peer is unwrapped",
			remote: "[2001:db8::2]:41000",
			want:   "2001:db8::2",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &http.Request{Header: http.Header{}, RemoteAddr: tc.remote}
			for name, value := range tc.headers {
				r.Header.Set(name, value)
			}
			if got := ClientIP(r); got != tc.want {
				t.Errorf("ClientIP() = %q, want %q", got, tc.want)
			}
		})
	}
}

// Repeats of one subject are free, distinct subjects are not.
//
// The scenario that forced this: an office shares one public address, so it shares
// one bucket. An agent holding a code the human regenerated re-presents that same
// code forever, and charging it drained the burst everyone else's first attempt
// needed.
func TestAllowDistinctChargesOnlyNewSubjects(t *testing.T) {
	// No refill worth speaking of, so every allowance below comes from the burst.
	l := New(0.0001, 4)

	for i := 0; i < 50; i++ {
		if !l.AllowDistinct("ip", "stale-code") {
			t.Fatalf("repeat %d of one subject was refused; repeats must be free", i)
		}
	}

	// The burst is still intact for genuinely new subjects — one token went on the
	// first sighting of "stale-code", leaving three.
	for i := 0; i < 3; i++ {
		if !l.AllowDistinct("ip", "guess-"+string(rune('a'+i))) {
			t.Fatalf("distinct subject %d refused, want the rest of the burst available", i)
		}
	}
	if l.AllowDistinct("ip", "guess-d") {
		t.Error("a fourth distinct subject was allowed; distinct subjects must each cost a token")
	}
	// ...and the exhausted bucket still serves a subject already paid for.
	if !l.AllowDistinct("ip", "stale-code") {
		t.Error("a paid-for subject was refused once the bucket emptied; repeats must not need a token")
	}
}

// A refused subject stays chargeable, or a guess refused once would be free ever
// after — which is the whole limiter, inverted.
func TestAllowDistinctForgetsRefusals(t *testing.T) {
	l := New(0.0001, 1)

	if !l.AllowDistinct("ip", "first") {
		t.Fatal("first subject refused with a full burst")
	}
	if l.AllowDistinct("ip", "second") {
		t.Fatal("second subject allowed with an empty bucket")
	}
	if l.AllowDistinct("ip", "second") {
		t.Error("a refused subject was allowed on retry, so the refusal was remembered as a payment")
	}
}

// The per-key memory is bounded, and the oldest entry is what goes.
func TestAllowDistinctBoundsItsMemory(t *testing.T) {
	subjects := make([]string, maxDistinctSubjects+1)
	for i := range subjects {
		subjects[i] = "code-" + strconv.Itoa(i)
	}
	// Exactly enough tokens to pay for each subject once, and none to spare.
	l := New(0.0001, len(subjects))
	for _, subject := range subjects {
		if !l.AllowDistinct("ip", subject) {
			t.Fatalf("%q refused while tokens remained", subject)
		}
	}

	if !l.AllowDistinct("ip", subjects[len(subjects)-1]) {
		t.Error("the newest subject was forgotten; eviction must drop the oldest")
	}
	if l.AllowDistinct("ip", subjects[0]) {
		t.Error("the evicted subject was served for free, so the memory is not bounded")
	}
}

// Buckets are per key: one address exhausting itself must not ration another.
func TestAllowDistinctKeysIndependently(t *testing.T) {
	l := New(0.0001, 1)
	if !l.AllowDistinct("ip-a", "code") {
		t.Fatal("first call refused")
	}
	if l.AllowDistinct("ip-a", "other") {
		t.Fatal("ip-a allowed a second distinct subject with an empty bucket")
	}
	if !l.AllowDistinct("ip-b", "other") {
		t.Error("ip-b was rationed by ip-a's spending")
	}
}
