package session

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Hash turns a pairing code into the registry's bucket key.
func Hash(code string) string {
	sum := sha256.Sum256([]byte(Normalize(code)))
	return hex.EncodeToString(sum[:])
}

// Normalize folds the ways a human can retype a code back onto what the tab generated.
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
