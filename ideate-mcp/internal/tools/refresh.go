package tools

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// This file exists because a redeployed service and a running agent disagree about what tools
// exist, and nothing in the request/response flow ever tells either one.

// Capabilities is what the MCP server has to advertise for any of the above to happen, and it lives
// here rather than at the call site so a server built for a test advertises what the real one does.
func Capabilities() *mcp.ServerCapabilities {
	return &mcp.ServerCapabilities{
		Logging: &mcp.LoggingCapabilities{},
		Tools:   &mcp.ToolCapabilities{ListChanged: true},
	}
}

const (
	// Long enough for the subscription the middleware just saw to be registered:
	// the SDK's handler records it and then blocks, so this only has to outlast the
	// call we are wrapping. Short enough that a human waiting for a new tool to
	// appear does not notice the wait.
	refreshDelay = 750 * time.Millisecond
	// A deploy brings every client back at once, and one notification serves all of them, so the burst
	// is coalesced on its trailing edge.
	refreshMaxWait = 5 * time.Second
)

// refresher coalesces subscription arrivals into single tool-list notifications.
type refresher struct {
	pulse func()
	log   *slog.Logger

	mu    sync.Mutex
	timer *time.Timer
	at    time.Time // when the pending pulse is due
	since time.Time // when the pending batch started
}

// announceRefresh installs the middleware that watches for subscriptions.
//
// Middleware rather than a tool: subscriptions/listen is not a tool call, and this
// has to see it before the SDK's handler parks on it for the life of the stream.
func announceRefresh(server *mcp.Server, log *slog.Logger, pulse func()) {
	if pulse == nil {
		return
	}
	if log == nil {
		log = slog.Default()
	}
	r := &refresher{pulse: pulse, log: log}
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if subscribesToToolList(req) {
				r.schedule()
			}
			return next(ctx, method, req)
		}
	})
}

// subscribesToToolList reports whether req is a subscription that asked for tool
// list changes. Typed rather than matched on the method name so a rename upstream
// is a compile error instead of a mechanism that quietly stops working.
func subscribesToToolList(req mcp.Request) bool {
	listen, ok := req.(*mcp.SubscriptionsListenRequest)
	if !ok || listen.Params == nil || listen.Params.Notifications == nil {
		return false
	}
	return listen.Params.Notifications.ToolsListChanged
}

func (r *refresher) schedule() {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	if r.since.IsZero() {
		r.since = now
	}
	at := now.Add(refreshDelay)
	if deadline := r.since.Add(refreshMaxWait); at.After(deadline) {
		at = deadline
	}
	if r.timer == nil {
		r.at = at
		r.timer = time.AfterFunc(time.Until(at), r.fire)
		return
	}
	// Only ever pushed later, never earlier: an earlier pulse could beat the
	// subscription that provoked it into the subscriber map.
	if at.After(r.at) {
		r.at = at
		r.timer.Reset(time.Until(at))
	}
}

func (r *refresher) fire() {
	r.mu.Lock()
	r.timer, r.at, r.since = nil, time.Time{}, time.Time{}
	r.mu.Unlock()

	r.log.Info("announcing tool list change")
	r.pulse()
}
