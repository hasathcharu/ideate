// Command server is the Ideate Agent Link service: one process that is both the
// MCP server an agent talks to and the relay that reaches the browser tab.
//
//	agent ──MCP Streamable HTTP──► server ──WebSocket──► browser tab
//
// It replaces a Node MCP server that ran on the user's own machine and *listened*
// on loopback while the tab dialled out to it. That arrangement could not work in
// Safari at all — no loopback exemption for mixed content, so ws://127.0.0.1 from
// an https page is blocked outright — and it confined the feature to an agent
// sitting on the same machine as the browser, ruling out containers, Codespaces,
// SSH boxes and browser-based agents. Inverting it costs the ability to work
// offline and gains everything else.
//
// Run it with no configuration at all and it listens on :7391 with defaults sized
// for a 512MB / 0.5-vCPU box. That is deliberate: the capacity error tells users to
// run their own, and that has to be true without a page of setup.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hasathcharu/ideate/ideate-relay/internal/config"
	"github.com/hasathcharu/ideate/ideate-relay/internal/httpapi"
	"github.com/hasathcharu/ideate/ideate-relay/internal/protocol"
	"github.com/hasathcharu/ideate/ideate-relay/internal/session"
	"github.com/hasathcharu/ideate/ideate-relay/internal/tools"
)

// version is stamped by the build (-ldflags "-X main.version=...") and is only
// ever diagnostic. What the two sides actually agree on is protocol.Version.
var version = "dev"

// sweepInterval drives the reaper: expired grace windows, idled-out attachments,
// and stale rate-limiter keys. Well under the shortest thing it collects
// (TAB_GRACE, 30s by default), so a bucket is never held much past its welcome.
const sweepInterval = 10 * time.Second

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	if err := run(log); err != nil {
		log.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	// Cancelled on SIGINT/SIGTERM, and it is what closes live tab sockets: a
	// hijacked WebSocket hangs off this rather than off its own request context,
	// which the HTTP server stops managing the moment the connection is hijacked.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	registry, err := session.NewRegistry(session.Options{
		MaxSessions:       cfg.MaxWSSessions,
		TabGrace:          cfg.TabGrace,
		AttachIdleTimeout: cfg.AttachIdleTimeout,
		RequestTimeout:    cfg.RequestTimeout,
		MaxInflightBytes:  cfg.MaxInflightBytes,
		Logger:            log,
	})
	if err != nil {
		return err
	}

	mcpServer := mcp.NewServer(&mcp.Implementation{
		Name:    "ideate",
		Version: version,
	}, &mcp.ServerOptions{
		Instructions: "Ideate hands you the diagram, markdown document or canvas open in a " +
			"human's browser right now. Every tool takes the pairing code shown in that " +
			"tab's Agent Link dialog; call ideate_status with it first to see what is " +
			"open, then ideate_connect to attach before reading or editing. Nothing you " +
			"do is committed to their repository — saving stays a human action.",
	})

	api, err := httpapi.New(httpapi.Options{
		Config:      cfg,
		Registry:    registry,
		MCP:         mcpServer,
		Logger:      log,
		BaseContext: ctx,
	})
	if err != nil {
		return err
	}
	// Registered after the API exists because the tools need its unknown-code
	// limiter, and the limiter belongs to the layer that also rations by address.
	tools.Register(mcpServer, &tools.Deps{
		Registry:    registry,
		UnknownCode: api.UnknownCodeLimiter(),
	})

	go sweep(ctx, registry, api)

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: an MCP streamable response and a tab WebSocket are both
		// long-lived by design, and a write deadline would sever them on a timer.
		IdleTimeout: 120 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}

	log.Info("listening",
		"addr", cfg.Addr,
		"protocol", protocol.Version,
		"version", version,
		"maxSessions", cfg.MaxWSSessions,
		"allowedOrigins", cfg.AllowedOrigins,
		"publicURL", cfg.PublicURL,
	)

	errs := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- err
		}
	}()

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}

	log.Info("shutting down")
	// Cancelling ctx above already closed the tab sockets; this drains in-flight
	// HTTP requests. Short, because a platform's own kill timer is not generous and
	// a half-finished shutdown is worse than a clean one.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return server.Shutdown(shutdownCtx)
}

func sweep(ctx context.Context, registry *session.Registry, api *httpapi.Server) {
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			registry.Sweep()
			api.Sweep()
		}
	}
}
