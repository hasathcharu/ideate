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
const LocalMCPPort = "7391"

// ValidateMCPOrigin enforces that a MCP origin is either TLS or unmistakably local.
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

	// AllowedOrigins is a **soft** allowlist applied to the tab's WebSocket handshake.
	AllowedOrigins []string

	// RequestTimeout bounds one forwarded command. A timeout is a tool error the
	// agent can act on ("the tab did not answer"), not a transport failure.
	RequestTimeout time.Duration

	// TabGrace is how long a bucket outlives its tab socket. A reload or a flaky
	// network should not cost the agent its attachment and force the human to
	// re-pair.
	TabGrace time.Duration

	// AttachIdleTimeout expires an attachment that has seen no tool calls.
	AttachIdleTimeout time.Duration

	// MaxBodyBytes caps an MCP request body.
	MaxBodyBytes int64

	// MaxWSSessions caps concurrent tab buckets. See session.Registry for why a
	// bucket inside its grace window still occupies one.
	MaxWSSessions int

	// StatsUser and StatsPassword gate the operator's census endpoint.
	StatsUser     string
	StatsPassword string

	// MaxInflightBytes is a global budget for forwarded command payloads.
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
