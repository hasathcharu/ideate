package session

import "testing"

// Codes are Crockford base32 precisely so a human can read one aloud and the
// listener's transcription still resolves: the alphabet omits I, L, O and U, so a
// typed "I" can only have been a 1 and an "O" a 0. Case and the display dash carry
// no information either.
func TestNormalize(t *testing.T) {
	const canonical = "K7QM4XZP"
	for _, typed := range []string{
		"K7QM4XZP",
		"k7qm4xzp",
		"K7QM-4XZP",
		"k7qm 4xzp",
		"  K7QM-4XZP  ",
		"K7QM_4XZP",
	} {
		if got := Normalize(typed); got != canonical {
			t.Errorf("Normalize(%q) = %q, want %q", typed, got, canonical)
		}
	}

	// The substitutions, which only make sense because the alphabet excludes the
	// characters being substituted away.
	if got := Normalize("i1lLoO"); got != "111100" {
		t.Errorf("Normalize(%q) = %q, want %q", "i1lLoO", got, "111100")
	}

	// Garbage normalizes to garbage rather than to an error: it simply matches no
	// bucket, and the unknown-code limiter treats that as the guess it is.
	if got := Normalize("!!! ???"); got != "" {
		t.Errorf("Normalize of punctuation = %q, want empty", got)
	}
}

func TestHashIsStableAndNormalizing(t *testing.T) {
	if Hash("K7QM4XZP") != Hash("k7qm-4xzp") {
		t.Error("two spellings of one code hashed differently")
	}
	if Hash("K7QM4XZP") == Hash("K7QM4XZQ") {
		t.Error("two different codes hashed the same")
	}
	if len(Hash("K7QM4XZP")) != 64 {
		t.Errorf("hash length = %d, want 64 hex characters", len(Hash("K7QM4XZP")))
	}
	// The code must never appear in a log line, so what does appear is a prefix of
	// the hash: enough to follow one session through a log file, useless for
	// reaching it.
	if key := LogKey(Hash("K7QM4XZP")); len(key) != 8 {
		t.Errorf("LogKey = %q, want 8 characters", key)
	}
}
