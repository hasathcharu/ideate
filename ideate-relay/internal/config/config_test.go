package config

import "testing"

// The Go half of the TLS rule. Its twin is validateRelayOrigin in
// app/lib/relayOrigin.ts, and these cases are deliberately the same list, because
// the two implementations disagreeing is the only way this control fails quietly:
// the browser would accept an origin the service rejects, and the user would find
// out from a connection that never comes up.
func TestValidateRelayOrigin(t *testing.T) {
	valid := []string{
		"https://relay.ideate.haru.lk",
		"https://relay.example.com:8443",
		"https://relay.example.com/",
		"http://localhost:7391",
		"http://127.0.0.1:7391",
	}
	for _, origin := range valid {
		if err := ValidateRelayOrigin(origin); err != nil {
			t.Errorf("ValidateRelayOrigin(%q) = %v, want nil", origin, err)
		}
	}

	invalid := map[string]string{
		"":                              "empty",
		"   ":                           "empty",
		"relay.example.com":             "a bare host names no scheme",
		"http://relay.example.com":      "plaintext off loopback",
		"http://localhost:3000":         "loopback on the wrong port — the exemption is one port, or http://localhost:80 walks back in",
		"http://localhost":              "loopback with no port",
		"http://127.0.0.1:7392":         "near-miss port",
		"ws://localhost:7391":           "the tab derives ws:// itself; this field is an http origin",
		"wss://relay.example.com":       "same",
		"ftp://relay.example.com":       "not a web scheme at all",
		"https://relay.example.com/mcp": "a path means someone pasted the endpoint",
		"https://relay.example.com?x=1": "query",
		"https://":                      "no host",
	}
	for origin, why := range invalid {
		if err := ValidateRelayOrigin(origin); err == nil {
			t.Errorf("ValidateRelayOrigin(%q) = nil, want an error (%s)", origin, why)
		}
	}
}

// Any localhost port passes the soft allowlist without being configured: a dev
// server moves around (3000, then 3001 when 3000 is taken) and every one of those
// is the developer's own machine. Enumerating ports they do not control would be
// friction with no security to show for it — the pairing code is the control.
func TestOriginAllowed(t *testing.T) {
	cfg := Config{AllowedOrigins: []string{"https://ideate.haru.lk"}}

	allowed := []string{
		"https://ideate.haru.lk",
		"https://ideate.haru.lk/",
		"http://localhost:3000",
		"http://localhost:3001",
		"http://127.0.0.1:5173",
	}
	for _, origin := range allowed {
		if !cfg.OriginAllowed(origin) {
			t.Errorf("OriginAllowed(%q) = false, want true", origin)
		}
	}

	denied := []string{"", "https://evil.example", "https://ideate.haru.lk.evil.example"}
	for _, origin := range denied {
		if cfg.OriginAllowed(origin) {
			t.Errorf("OriginAllowed(%q) = true, want false", origin)
		}
	}
}

// Half-configured stats credentials are a startup error rather than a disabled
// endpoint. An operator who set one of the two believes the route is protected, and
// the two ways of being wrong about that are "published to the internet" and
// "unreachable by me" — neither should be arrived at silently.
func TestStatsCredentialsMustBePaired(t *testing.T) {
	t.Run("neither leaves the endpoint off", func(t *testing.T) {
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() = %v, want nil", err)
		}
		if cfg.StatsUser != "" || cfg.StatsPassword != "" {
			t.Errorf("credentials = %q/%q, want empty", cfg.StatsUser, cfg.StatsPassword)
		}
	})

	t.Run("user alone is an error", func(t *testing.T) {
		t.Setenv("STATS_USER", "ops")
		if _, err := Load(); err == nil {
			t.Error("Load() = nil, want an error for STATS_USER without STATS_PASSWORD")
		}
	})

	t.Run("password alone is an error", func(t *testing.T) {
		t.Setenv("STATS_PASSWORD", "secret")
		if _, err := Load(); err == nil {
			t.Error("Load() = nil, want an error for STATS_PASSWORD without STATS_USER")
		}
	})

	t.Run("both together load", func(t *testing.T) {
		t.Setenv("STATS_USER", "ops")
		t.Setenv("STATS_PASSWORD", "secret")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() = %v, want nil", err)
		}
		if cfg.StatsUser != "ops" || cfg.StatsPassword != "secret" {
			t.Errorf("credentials = %q/%q, want ops/secret", cfg.StatsUser, cfg.StatsPassword)
		}
	})
}
