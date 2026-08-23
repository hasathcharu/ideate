package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hasathcharu/ideate/ideate-mcp/internal/config"
	"github.com/hasathcharu/ideate/ideate-mcp/internal/httpapi"
	"github.com/hasathcharu/ideate/ideate-mcp/internal/protocol"
	"github.com/hasathcharu/ideate/ideate-mcp/internal/session"
	"github.com/hasathcharu/ideate/ideate-mcp/internal/tools"
)

// Everything the bridge actually does lives in the interaction between an HTTP
// request, a WebSocket, and a clock — none of which a typechecker can see. Two real
// bugs in the previous implementation were found only by driving it, so this file
// drives it: a real MCP client over real HTTP, a real WebSocket standing in for the
// tab, and an injected clock so the grace window and the idle timeout can be tested
// in microseconds instead of minutes.

const testCode = "K7QM4XZP"

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

// fakeClock lets a test step over TAB_GRACE and ATTACH_IDLE_TIMEOUT without
// sleeping through them. Only the registry reads it; sockets and HTTP still run on
// real time, which is the right split — the durations under test are policy, and
// the I/O under test is not.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

type harness struct {
	t      *testing.T
	server *httptest.Server
	reg    *session.Registry
	api    *httpapi.Server
	clock  *fakeClock
}

// newHarness starts the whole service on a random port. `tune` may adjust the
// config before anything is built, which is how the capacity and timeout tests get
// their extreme values.
func newHarness(t *testing.T, tune func(*config.Config)) *harness {
	t.Helper()

	cfg := config.Config{
		AllowedOrigins:    config.DefaultAllowedOrigins,
		RequestTimeout:    config.DefaultRequestTimeout,
		TabGrace:          config.DefaultTabGrace,
		AttachIdleTimeout: config.DefaultAttachIdleTimeout,
		MaxBodyBytes:      config.DefaultMaxBodyBytes,
		MaxWSSessions:     config.DefaultMaxWSSessions,
		MaxInflightBytes:  config.DefaultMaxInflightBytes,
	}
	if tune != nil {
		tune(&cfg)
	}

	clock := newClock()
	// Quiet by default: a failing test wants the assertion, not a hundred lines of
	// structured logging around it.
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	reg, err := session.NewRegistry(session.Options{
		MaxSessions:       cfg.MaxWSSessions,
		TabGrace:          cfg.TabGrace,
		AttachIdleTimeout: cfg.AttachIdleTimeout,
		RequestTimeout:    cfg.RequestTimeout,
		MaxInflightBytes:  cfg.MaxInflightBytes,
		Logger:            log,
		Now:               clock.Now,
	})
	if err != nil {
		t.Fatalf("registry: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	mcpServer := mcp.NewServer(&mcp.Implementation{Name: "ideate", Version: "test"}, nil)
	api, err := httpapi.New(httpapi.Options{
		Config: cfg, Registry: reg, MCP: mcpServer, Logger: log, BaseContext: ctx,
		// The same clock the registry gets, so the CPU-usage window in /v1/stats is
		// as steppable as the grace window.
		Now: clock.Now,
	})
	if err != nil {
		t.Fatalf("httpapi: %v", err)
	}
	tools.Register(mcpServer, &tools.Deps{Registry: reg, UnknownCode: api.UnknownCodeLimiter()})

	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)

	return &harness{t: t, server: server, reg: reg, api: api, clock: clock}
}

func (h *harness) wsURL() string {
	return "ws" + strings.TrimPrefix(h.server.URL, "http") + protocol.TabPath
}

/* ------------------------------------------------------------------ */
/* The tab                                                             */
/* ------------------------------------------------------------------ */

// fakeTab stands in for the browser. It speaks the same frames lib/agentLink.ts
// does, and nothing more — the point is to exercise the service, not to reimplement
// the editor.
type fakeTab struct {
	t         *testing.T
	conn      *websocket.Conn
	cancel    context.CancelFunc
	frames    chan json.RawMessage  // ready / attached / detached
	reqs      chan protocol.Request // commands to answer
	closed    chan websocket.StatusCode
	closeOnce sync.Once
}

// dialTab opens a socket and sends a hello. `protocolVersion` is a parameter so the
// mismatch case can be driven; every other test passes protocol.Version.
func (h *harness) dialTab(code string, protocolVersion int) *fakeTab {
	h.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	h.t.Cleanup(cancel)

	conn, _, err := websocket.Dial(ctx, h.wsURL(), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"http://localhost:3000"}},
	})
	if err != nil {
		cancel()
		h.t.Fatalf("dial tab: %v", err)
	}
	conn.SetReadLimit(protocol.MaxFrameBytes + 1)

	tab := &fakeTab{
		t:      h.t,
		conn:   conn,
		cancel: cancel,
		frames: make(chan json.RawMessage, 8),
		reqs:   make(chan protocol.Request, 8),
		closed: make(chan websocket.StatusCode, 1),
	}
	h.t.Cleanup(tab.close)

	go tab.read(ctx)

	if code != "" {
		tab.send(protocol.Hello{T: protocol.THello, Code: code, Protocol: protocolVersion})
	}
	return tab
}

func (tab *fakeTab) read(ctx context.Context) {
	for {
		_, raw, err := tab.conn.Read(ctx)
		if err != nil {
			status := websocket.CloseStatus(err)
			select {
			case tab.closed <- status:
			default:
			}
			return
		}
		switch protocol.Tag(raw) {
		case protocol.TReq:
			var req protocol.Request
			if json.Unmarshal(raw, &req) == nil {
				tab.reqs <- req
			}
		default:
			tab.frames <- append(json.RawMessage(nil), raw...)
		}
	}
}

func (tab *fakeTab) send(frame any) {
	tab.t.Helper()
	payload, err := json.Marshal(frame)
	if err != nil {
		tab.t.Fatalf("marshal frame: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := tab.conn.Write(ctx, websocket.MessageText, payload); err != nil {
		tab.t.Fatalf("write frame: %v", err)
	}
}

func (tab *fakeTab) close() {
	tab.closeOnce.Do(func() {
		_ = tab.conn.Close(websocket.StatusNormalClosure, "")
		tab.cancel()
	})
}

// nextFrame waits for the next non-req frame and returns its tag plus the raw
// bytes, so a test can assert on both.
func (tab *fakeTab) nextFrame(within time.Duration) (string, json.RawMessage) {
	tab.t.Helper()
	select {
	case raw := <-tab.frames:
		return protocol.Tag(raw), raw
	case status := <-tab.closed:
		tab.t.Fatalf("socket closed with %d while waiting for a frame", status)
	case <-time.After(within):
		tab.t.Fatalf("no frame within %s", within)
	}
	return "", nil
}

func (tab *fakeTab) expectFrame(tag string) json.RawMessage {
	tab.t.Helper()
	got, raw := tab.nextFrame(3 * time.Second)
	if got != tag {
		tab.t.Fatalf("frame tag = %q, want %q (%s)", got, tag, raw)
	}
	return raw
}

// expectReady is the pairing handshake every happy-path test starts with.
func (tab *fakeTab) expectReady() { tab.expectFrame(protocol.TReady) }

// expectClose asserts the service hung up with a particular private-use code.
func (tab *fakeTab) expectClose(want websocket.StatusCode) {
	tab.t.Helper()
	select {
	case got := <-tab.closed:
		if got != want {
			tab.t.Fatalf("close status = %d, want %d", got, want)
		}
	case <-time.After(3 * time.Second):
		tab.t.Fatalf("socket stayed open; expected close %d", want)
	}
}

func (tab *fakeTab) nextRequest(within time.Duration) (protocol.Request, bool) {
	select {
	case req := <-tab.reqs:
		return req, true
	case <-time.After(within):
		return protocol.Request{}, false
	}
}

func (tab *fakeTab) reply(id int64, data any) {
	tab.t.Helper()
	encoded, err := json.Marshal(data)
	if err != nil {
		tab.t.Fatalf("marshal reply: %v", err)
	}
	tab.send(protocol.Result{T: protocol.TRes, ID: id, OK: true, Data: encoded})
}

// answer runs a background loop replying to everything, which is what most tests
// want: they are about the service, not about what the editor would have said.
func (tab *fakeTab) answer(reply func(protocol.Command) any) {
	go func() {
		for {
			req, ok := tab.nextRequest(10 * time.Second)
			if !ok {
				return
			}
			tab.reply(req.ID, reply(req.Command))
		}
	}()
}

// pushState is how a real tab keeps ideate_status answerable without a round trip.
func (tab *fakeTab) pushState(state protocol.BridgeState) {
	tab.send(protocol.StateEvent{T: protocol.TEvent, Name: "state", State: state})
}

func sampleState() protocol.BridgeState {
	path := "diagrams/flow.mmd"
	return protocol.BridgeState{
		Mode:      "github",
		Repo:      &protocol.StateRepo{Owner: "hasathcharu", Name: "ideate", Branch: "v3", DefaultBranch: "main"},
		OpenPath:  &path,
		Kind:      "mermaid",
		Dirty:     true,
		LineCount: 12,
		CharCount: 214,
	}
}

/* ------------------------------------------------------------------ */
/* The agent                                                           */
/* ------------------------------------------------------------------ */

// agent connects a real MCP client over Streamable HTTP.
//
// Using the SDK's own client rather than hand-rolled JSON-RPC is the point: the
// service runs in Stateless mode, where GET /mcp answers 405, and whether a
// conforming client copes with that is exactly the compatibility question this
// transport rests on. A hand-written client would prove nothing about it.
func (h *harness) agent() *mcp.ClientSession {
	h.t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "test-agent", Version: "0"}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cs, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: h.server.URL + "/mcp",
	}, nil)
	if err != nil {
		h.t.Fatalf("connect MCP client: %v", err)
	}
	h.t.Cleanup(func() { _ = cs.Close() })
	return cs
}

type toolCall struct {
	text    string
	isError bool
}

func call(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) toolCall {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: transport error (should have been a tool error): %v", name, err)
	}
	var text strings.Builder
	for _, content := range res.Content {
		if tc, ok := content.(*mcp.TextContent); ok {
			text.WriteString(tc.Text)
		}
	}
	return toolCall{text: text.String(), isError: res.IsError}
}

// ok asserts the call succeeded, reporting the message when it did not — a failing
// tool call carries its reason in the content, and hiding it makes every failure in
// this file look the same.
func (c toolCall) ok(t *testing.T, what string) toolCall {
	t.Helper()
	if c.isError {
		t.Fatalf("%s failed: %s", what, c.text)
	}
	return c
}

func (c toolCall) failsWith(t *testing.T, substring string) {
	t.Helper()
	if !c.isError {
		t.Fatalf("expected a tool error, got success: %s", c.text)
	}
	if !strings.Contains(strings.ToLower(c.text), strings.ToLower(substring)) {
		t.Fatalf("error text %q does not mention %q", c.text, substring)
	}
}

func (c toolCall) decode(t *testing.T) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(c.text), &out); err != nil {
		t.Fatalf("result is not a JSON object: %v\n%s", err, c.text)
	}
	return out
}

// pair is the two-step every document test starts from: the human switched Agent
// Link on (the tab), then the agent decided to drive it (ideate_connect).
func (h *harness) pair(code string) (*fakeTab, *mcp.ClientSession) {
	h.t.Helper()
	tab := h.dialTab(code, protocol.Version)
	tab.expectReady()
	tab.pushState(sampleState())
	cs := h.agent()
	call(h.t, cs, "ideate_connect", map[string]any{"code": code, "agent": "Test Agent"}).
		ok(h.t, "ideate_connect")
	tab.expectFrame(protocol.TAttached)
	return tab, cs
}
