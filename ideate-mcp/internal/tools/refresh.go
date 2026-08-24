package tools

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// This file exists because a redeployed service and a running agent disagree about
// what tools exist, and nothing in the request/response flow ever tells either one.
//
// The service advertises `tools: {listChanged: true}` — the SDK infers it from
// having tools at all — but until SEP-2575 that capability was undeliverable here:
// stateless mode answers GET /mcp with 405, and every POST's session dies with the
// request, so there was no channel a server-initiated notification could travel on.
// SEP-2575 adds one, and adds it *only* for stateless servers: `subscriptions/listen`
// is a long-lived POST whose SSE stream is the channel. That is us.
//
// The capability was never the missing piece, though. Tools are registered once at
// boot, so from a fresh process's point of view the list has never changed — it has
// changed only from the point of view of a client that listed it against the
// *previous* build. The two are told apart by one observable event: a client
// subscribing. A subscription arrives either because the client is new (it just
// listed the tools, so a notification costs it one redundant tools/list) or because
// its stream died and it came back — which, after a deploy, is exactly the client
// holding the stale list. So: announce a change whenever somebody subscribes, and
// the stale case fixes itself without anybody reconnecting anything.
//
// The notification itself has to be provoked rather than sent. The SDK owns the
// subscriber map and exposes no "notify this session", so the only lever is
// re-registering a tool: AddTool assumes a replacement is a change and notifies
// unconditionally. announceRefresh is handed that closure by Register, which builds
// it from the first tool it registers — no second copy of a tool definition, and
// nothing to keep in sync.

// Capabilities is what the MCP server has to advertise for any of the above to
// happen, and it lives here rather than at the call site so a server built for a
// test advertises what the real one does.
//
// The SDK would infer tools.listChanged from the server having tools at all, but an
// inference is not a thing to rest a mechanism on. Logging is spelled out only
// because a non-nil Capabilities replaces the SDK's default instead of adding to it.
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
	// A deploy brings every client back at once, and one notification serves all of
	// them, so the burst is coalesced on its trailing edge. The cap is what stops a
	// steady trickle of subscriptions from postponing the pulse forever — silently
	// never firing is the one failure mode of this whole mechanism that would look
	// exactly like the bug it fixes.
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
