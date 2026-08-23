// Package config loads the service's settings from the environment, and owns the
// Go half of the TLS rule that also lives in app/lib/mcpOrigin.ts.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// LocalMCPPort is the one port on which a plaintext MCP origin is allowed.
//
// 7391 is the old loopback bridge port, kept deliberately: it no longer means
// anything to the protocol, but it is the number that appears in every older
// README and in muscle memory, and reusing it for "a service you run yourself"
// costs nothing and saves an explanation.
const LocalMCPPort = "7391"

// ValidateMCPOrigin enforces that a MCP origin is either TLS or unmistakably
// local. It mirrors validateMcpOrigin in app/lib/mcpOrigin.ts.
//
// This is a security control, and the reason it is checked here as well as in the
// browser is that the browser's copy is a courtesy to whoever types into the
// Advanced options field — it protects that person from a typo, not the service
// from anyone. Plaintext anywhere but loopback means the pairing code, and every
// document the tab is asked to read, crosses the network in the clear.
//
// The exemption is narrow on purpose: loopback *and* the one port, because
// "http://localhost:anything" would quietly re-admit a plaintext proxy on 80.
func ValidateMCPOrigin(raw string) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return errors.New("MCP origin is empty")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return fmt.Errorf("MCP origin %q is not a URL: %w", raw, err)
	}
	// An origin, not a URL: a path here means someone pasted the /mcp endpoint,
	// and silently ignoring it would leave them wondering why their edit did
	// nothing.
	if parsed.Path != "" && parsed.Path != "/" {
		return fmt.Errorf("MCP origin %q must be scheme://host with no path", raw)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("MCP origin %q must be scheme://host with no query or fragment", raw)
	}
	if parsed.Hostname() == "" {
		return fmt.Errorf("MCP origin %q names no host", raw)
	}
	switch parsed.Scheme {
	case "https":
		return nil
	case "http":
		host := parsed.Hostname()
		if (host == "localhost" || host == "127.0.0.1") && parsed.Port() == LocalMCPPort {
			return nil
		}
		return fmt.Errorf(
			"MCP origin %q must use https — plaintext is allowed only on "+
				"http://localhost:%s or http://127.0.0.1:%s", raw, LocalMCPPort, LocalMCPPort)
	default:
		return fmt.Errorf("MCP origin %q must use https (or http on loopback)", raw)
	}
}

// Config is the whole of the service's configuration. Every field has a default
// that is correct for the shared deployment, so the service starts with no
// environment set at all — which is what makes "run your own, it's one binary" an
// honest thing to say in the capacity error.
type Config struct {
	// Addr is the listen address, from PORT.
	Addr string

	// PublicURL is the origin this instance is reached at, when it is known. Only
	// used for diagnostics and the setup line the operator is told to hand out —
	// but validated with the same rule the app applies, so an operator cannot
	// advertise a plaintext service and find out from their users.
	PublicURL string

	// AllowedOrigins is a **soft** allowlist applied to the tab's WebSocket
	// handshake. It stops the service being used as free infrastructure by pages
	// that are nothing to do with Ideate. It is emphatically not the security
	// control — the pairing code is. A local process can spoof Origin, and a
	// browser page that spoofed it still could not guess a code.
	AllowedOrigins []string

	// RequestTimeout bounds one forwarded command. A timeout is a tool error the
	// agent can act on ("the tab did not answer"), not a transport failure.
	RequestTimeout time.Duration

	// TabGrace is how long a bucket outlives its tab socket. A reload or a flaky
	// network should not cost the agent its attachment and force the human to
	// re-pair.
	TabGrace time.Duration

	// AttachIdleTimeout expires an attachment that has seen no tool calls.
	//
	// A stateful MCP session would detach on client teardown for free; stateless
	// has nothing to hook. Without this, an agent that was killed leaves the
	// toolbar claiming someone can edit the document — which is the one thing the
	// attached/paired distinction exists to keep honest.
	AttachIdleTimeout time.Duration

	// MaxBodyBytes caps an MCP request body.
	MaxBodyBytes int64

	// MaxWSSessions caps concurrent tab buckets. See session.Registry for why a
	// bucket inside its grace window still occupies one.
	MaxWSSessions int

	// StatsUser and StatsPassword gate the operator's census endpoint. Both empty
	// means the route does not exist.
	//
	// Basic auth over TLS, because the thing being protected is a handful of
	// integers and the client is a curl in a terminal or an uptime checker — a
	// token-issuing scheme would be more apparatus than the secret is worth. It is
	// credentials rather than nothing because the counts describe how many people
	// are using the service and when, which is the operator's business and not the
	// internet's.
	StatsUser     string
	StatsPassword string

	// MaxInflightBytes is a global budget for forwarded command payloads.
	//
	// The memory risk here is many large frames at once, not idle sockets: an idle
	// tab connection is around 100KB including TLS and its goroutines, so the
	// session cap alone fits comfortably in a small box. MaxFrameBytes × the
	// session cap does not — 250 × 8MB is a 2GB spike on a 512MB machine.
	MaxInflightBytes int64
}

// Defaults, all sized for one 512MB / 0.5-vCPU instance.
const (
	DefaultRequestTimeout    = 15 * time.Second
	DefaultTabGrace          = 30 * time.Second
	DefaultAttachIdleTimeout = 30 * time.Minute
	DefaultMaxBodyBytes      = 8 << 20
	// 250 is one to two orders of magnitude above realistic load while still
	// being a hard bound, and it is one environment variable to raise. Sockets are
	// not the constraint; a human-driven agent issues a command every few seconds,
	// so even a full instance is nowhere near saturating half a core.
	DefaultMaxWSSessions    = 250
	DefaultMaxInflightBytes = 64 << 20
)

// DefaultAllowedOrigins is the deployment set plus any localhost port, since a dev
// server moves around (3000, then 3001 when 3000 is taken) and every one of those
// is the developer's own machine.
var DefaultAllowedOrigins = []string{"https://ideate.haru.lk"}

// Load reads the environment, applying a default for everything absent. It returns
// an error rather than falling back for anything *present and wrong*: a mistyped
// timeout silently reverting to 15s is the kind of thing that gets diagnosed months
// later.
func Load() (Config, error) {
	cfg := Config{
		Addr:              ":" + firstNonEmpty(os.Getenv("PORT"), LocalMCPPort),
		AllowedOrigins:    DefaultAllowedOrigins,
		RequestTimeout:    DefaultRequestTimeout,
		TabGrace:          DefaultTabGrace,
		AttachIdleTimeout: DefaultAttachIdleTimeout,
		MaxBodyBytes:      DefaultMaxBodyBytes,
		MaxWSSessions:     DefaultMaxWSSessions,
		MaxInflightBytes:  DefaultMaxInflightBytes,
	}

	if raw := strings.TrimSpace(os.Getenv("PUBLIC_URL")); raw != "" {
		if err := ValidateMCPOrigin(raw); err != nil {
			return cfg, fmt.Errorf("PUBLIC_URL: %w", err)
		}
		cfg.PublicURL = strings.TrimSuffix(raw, "/")
	}

	if raw := strings.TrimSpace(os.Getenv("ALLOWED_ORIGINS")); raw != "" {
		origins := make([]string, 0, 4)
		for _, entry := range strings.Split(raw, ",") {
			if trimmed := strings.TrimSuffix(strings.TrimSpace(entry), "/"); trimmed != "" {
				origins = append(origins, trimmed)
			}
		}
		if len(origins) == 0 {
			return cfg, errors.New("ALLOWED_ORIGINS is set but lists no origins")
		}
		cfg.AllowedOrigins = origins
	}

	// Half-configured credentials are a startup error, not a disabled endpoint: an
	// operator who set one of the two believes the route is protected, and the two
	// ways of being wrong here are "exposed" and "unreachable".
	cfg.StatsUser = strings.TrimSpace(os.Getenv("STATS_USER"))
	cfg.StatsPassword = os.Getenv("STATS_PASSWORD")
	if (cfg.StatsUser == "") != (cfg.StatsPassword == "") {
		return cfg, errors.New(
			"STATS_USER and STATS_PASSWORD must be set together, or neither set to " +
				"leave the stats endpoint off")
	}

	var err error
	if cfg.RequestTimeout, err = duration("REQUEST_TIMEOUT", cfg.RequestTimeout); err != nil {
		return cfg, err
	}
	if cfg.TabGrace, err = duration("TAB_GRACE", cfg.TabGrace); err != nil {
		return cfg, err
	}
	if cfg.AttachIdleTimeout, err = duration("ATTACH_IDLE_TIMEOUT", cfg.AttachIdleTimeout); err != nil {
		return cfg, err
	}
	if cfg.MaxBodyBytes, err = integer("MAX_BODY_BYTES", cfg.MaxBodyBytes); err != nil {
		return cfg, err
	}
	if cfg.MaxInflightBytes, err = integer("MAX_INFLIGHT_BYTES", cfg.MaxInflightBytes); err != nil {
		return cfg, err
	}
	sessions, err := integer("MAX_WS_SESSIONS", int64(cfg.MaxWSSessions))
	if err != nil {
		return cfg, err
	}
	cfg.MaxWSSessions = int(sessions)

	return cfg, nil
}

// OriginAllowed applies the soft allowlist. Any localhost origin passes regardless
// of configuration: it is the developer's own machine, and requiring them to
// enumerate ports they do not control is friction with no security to show for it.
func (c Config) OriginAllowed(origin string) bool {
	if origin == "" {
		return false
	}
	trimmed := strings.TrimSuffix(origin, "/")
	for _, allowed := range c.AllowedOrigins {
		if allowed == trimmed || allowed == "*" {
			return true
		}
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	return parsed.Scheme == "http" && (host == "localhost" || host == "127.0.0.1")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func duration(name string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil {
		return fallback, fmt.Errorf("%s=%q is not a duration (try 30s, 15m): %w", name, raw, err)
	}
	if parsed <= 0 {
		return fallback, fmt.Errorf("%s=%q must be positive", name, raw)
	}
	return parsed, nil
}

func integer(name string, fallback int64) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return fallback, fmt.Errorf("%s=%q is not a number: %w", name, raw, err)
	}
	if parsed <= 0 {
		return fallback, fmt.Errorf("%s=%q must be positive", name, raw)
	}
	return parsed, nil
}
