package session

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Hash turns a pairing code into the registry's bucket key.
//
// Hashing happens **here**, server-side, from the raw code. Having the client send
// a hash would gain nothing — whatever the client sends is what an attacker needs
// to send, so the hash would simply become the credential — and it would put the
// normalization below out of reach.
//
// The code itself must never be logged, put in a URL, or appear in a query string;
// see LogKey for what goes in a log line instead.
func Hash(code string) string {
	sum := sha256.Sum256([]byte(Normalize(code)))
	return hex.EncodeToString(sum[:])
}

// Normalize folds the ways a human can retype a code back onto what the tab
// generated.
//
// Codes are Crockford base32 precisely so this is possible: the alphabet omits I,
// L, O and U, so a transcribed "I" can only have been a 1 and an "O" a 0, with no
// ambiguity to resolve. Case and separators carry no information either — the tab
// shows XXXX-XXXX for readability, and someone reading it back to their agent may
// or may not include the dash.
//
// Anything else is dropped rather than rejected. A code that survives normalization
// as garbage simply fails to match a bucket, and the unknown-code limiter treats
// that as the guess it is.
func Normalize(code string) string {
	var b strings.Builder
	b.Grow(len(code))
	for _, r := range strings.ToUpper(code) {
		switch {
		case r == 'I' || r == 'L':
			b.WriteRune('1')
		case r == 'O':
			b.WriteRune('0')
		case (r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z'):
			b.WriteRune(r)
		}
	}
	return b.String()
}

// LogKey is the most of a bucket identity that may reach a log line: a short prefix
// of the hash, which is enough to follow one session through a log file and useless
// for reaching it. The code itself is a credential and never appears.
func LogKey(hash string) string {
	if len(hash) < 8 {
		return hash
	}
	return hash[:8]
}
