package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/hasathcharu/ideate/ideate-mcp/internal/config"
	"github.com/hasathcharu/ideate/ideate-mcp/internal/httpapi"
	"github.com/hasathcharu/ideate/ideate-mcp/internal/protocol"
	"github.com/hasathcharu/ideate/ideate-mcp/internal/session"
)

/* ------------------------------------------------------------------ */
/* Pairing                                                             */
/* ------------------------------------------------------------------ */

// The whole loop, end to end: a tab pairs, an agent attaches, an edit goes out, and
// the renderer's verdict comes back inside the tool result. That last part is the
// reason Agent Link exists at all — an agent editing files finds out its diagram is
// broken when a human next opens it; this one finds out in its own tool call.
func TestPairingHappyPath(t *testing.T) {
	h := newHarness(t, nil)
	tab, cs := h.pair(testCode)

	tab.answer(func(cmd protocol.Command) any {
		if cmd.Cmd != protocol.CmdEdit {
			t.Errorf("unexpected command %q", cmd.Cmd)
		}
		return map[string]any{
			"applied":   1,
			"lineCount": 12,
			"diagnostics": []map[string]any{
				{"label": nil, "message": "Parse error on line 3: expected a node id"},
			},
		}
	})

	result := call(t, cs, "ideate_edit", map[string]any{
		"code":  testCode,
		"edits": []map[string]any{{"oldText": "A --> B", "newText": "A --> C"}},
	}).ok(t, "ideate_edit")

	if !strings.Contains(result.text, "Parse error on line 3") {
		t.Fatalf("the renderer's diagnostics did not reach the agent:\n%s", result.text)
	}
}

// The code is normalized server-side, so the form a human reads off the screen and
// the form they type at their agent do not have to match. Crockford's alphabet is
// what makes the letter substitutions unambiguous.
func TestCodeIsNormalized(t *testing.T) {
	h := newHarness(t, nil)
	tab := h.dialTab(testCode, protocol.Version)
	tab.expectReady()
	tab.pushState(sampleState())
	cs := h.agent()

	for _, typed := range []string{"K7QM4XZP", "k7qm-4xzp", "K7QM 4XZP", "k7qm4xzp"} {
		call(t, cs, "ideate_status", map[string]any{"code": typed}).
			ok(t, fmt.Sprintf("ideate_status with %q", typed))
	}
}

// A second tab on the same code is turned away rather than allowed to displace the
// first. Newest-wins would let anything that guessed a code silently take over the
// human's real editor.
func TestSecondTabRefused(t *testing.T) {
	h := newHarness(t, nil)
	first := h.dialTab(testCode, protocol.Version)
	first.expectReady()

	second := h.dialTab(testCode, protocol.Version)
	second.expectClose(protocol.CloseSlotTaken)

	// And the original is untouched.
	if !h.reg.Lookup(hashOf(testCode)).HasTab() {
		t.Fatal("the first tab lost its bucket to the refused one")
	}
}

func TestProtocolMismatchRefused(t *testing.T) {
	h := newHarness(t, nil)
	tab := h.dialTab(testCode, protocol.Version-1)
	tab.expectClose(protocol.CloseProtocolMismatch)
}

func TestHelloDeadline(t *testing.T) {
	h := newHarness(t, nil)
	tab := h.dialTab("", 0) // dial, then say nothing
	tab.expectClose(protocol.CloseBadHello)
}

func TestBadOriginRefused(t *testing.T) {
	h := newHarness(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, h.wsURL(), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://evil.example"}},
	})
	if err == nil {
		t.Fatal("handshake succeeded from a disallowed origin")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %v, want 403", resp)
	}
}

/* ------------------------------------------------------------------ */
/* Attachment                                                          */
/* ------------------------------------------------------------------ */

// Pairing says *which* tab; attaching says *whether* to drive it. Everything that
// touches the document is refused until an agent has answered the second question.
func TestToolCallBeforeAttach(t *testing.T) {
	h := newHarness(t, nil)
	tab := h.dialTab(testCode, protocol.Version)
	tab.expectReady()
	tab.pushState(sampleState())
	cs := h.agent()

	for _, name := range []string{
		"ideate_read", "ideate_check", "ideate_list_files", "ideate_scene_get",
	} {
		call(t, cs, name, map[string]any{"code": testCode}).failsWith(t, "ideate_connect")
	}

	// The tab must not have been asked anything at all.
	if _, ok := tab.nextRequest(200 * time.Millisecond); ok {
		t.Fatal("an unattached tool call reached the tab")
	}
}

// ideate_status is the single exception, and it stays an exception only while it
// answers with metadata and never content: it is what lets an agent describe what
// attaching would give it without first helping itself to it.
func TestStatusWorksUnattachedAndReturnsNoContent(t *testing.T) {
	h := newHarness(t, nil)
	tab := h.dialTab(testCode, protocol.Version)
	tab.expectReady()
	tab.pushState(sampleState())

	cs := h.agent()
	result := call(t, cs, "ideate_status", map[string]any{"code": testCode}).ok(t, "ideate_status")

	body := result.decode(t)
	if body["attached"] != false {
		t.Errorf("attached = %v, want false", body["attached"])
	}
	tabInfo, _ := body["tab"].(map[string]any)
	if tabInfo["openPath"] != "diagrams/flow.mmd" {
		t.Errorf("status did not report which document is open: %v", body["tab"])
	}
	// The theme is metadata about how the app *renders*, not about what the document
	// says, so it belongs on the unattached side of the line with the rest of
	// BridgeState — and an agent that cannot see it writes colors into files.
	themeInfo, _ := tabInfo["theme"].(map[string]any)
	if themeInfo["name"] != "tokyo-night" || themeInfo["mode"] != "dark" {
		t.Errorf("status did not report the theme: %v", tabInfo["theme"])
	}
	// BridgeState has no field carrying document text, and this is the assertion
	// that keeps it that way: adding one would leak the document to an unattached
	// agent through this call.
	if strings.Contains(result.text, "flowchart") || strings.Contains(result.text, "\"text\"") {
		t.Errorf("unattached status leaked document content:\n%s", result.text)
	}
	if _, ok := tab.nextRequest(200 * time.Millisecond); ok {
		t.Fatal("unattached status round-tripped to the tab")
	}
}

// Idempotent for the same agent, refused for a different one. The refusal is not a
// security boundary — anyone holding the code could have attached first — it is
// there so two agents cannot quietly fight over one document, and the idempotence
// is what lets an agent that restarted pick up where it was.
func TestReattach(t *testing.T) {
	h := newHarness(t, nil)
	tab, cs := h.pair(testCode)

	call(t, cs, "ideate_connect", map[string]any{"code": testCode, "agent": "Test Agent"}).
		ok(t, "re-attach by the same agent")
	tab.expectFrame(protocol.TAttached)

	call(t, cs, "ideate_connect", map[string]any{"code": testCode, "agent": "Somebody Else"}).
		failsWith(t, "already attached")
}

func TestDisconnectPushesDetached(t *testing.T) {
	h := newHarness(t, nil)
	tab, cs := h.pair(testCode)

	call(t, cs, "ideate_disconnect", map[string]any{"code": testCode}).ok(t, "ideate_disconnect")
	tab.expectFrame(protocol.TDetached)

	call(t, cs, "ideate_read", map[string]any{"code": testCode}).failsWith(t, "ideate_connect")
}

// A stateful MCP session would detach on client teardown for free. Stateless has
// nothing to hook, so without this an agent that was killed would leave the toolbar
// claiming somebody can edit the document — which is the one thing the
// paired/attached split exists to keep honest.
func TestAttachmentIdlesOut(t *testing.T) {
	h := newHarness(t, func(c *config.Config) { c.AttachIdleTimeout = 30 * time.Minute })
	tab, cs := h.pair(testCode)

	h.clock.Advance(29 * time.Minute)
	h.reg.Sweep()
	if attached, _ := h.reg.Lookup(hashOf(testCode)).Attached(); !attached {
		t.Fatal("attachment expired early")
	}

	h.clock.Advance(2 * time.Minute)
	h.reg.Sweep()

	tab.expectFrame(protocol.TDetached)
	call(t, cs, "ideate_read", map[string]any{"code": testCode}).failsWith(t, "ideate_connect")
}

/* ------------------------------------------------------------------ */
/* Unknown codes and rate limiting                                     */
/* ------------------------------------------------------------------ */

func TestUnknownCode(t *testing.T) {
	h := newHarness(t, nil)
	cs := h.agent()
	call(t, cs, "ideate_status", map[string]any{"code": "ZZZZ9999"}).
		failsWith(t, "no browser tab is paired")
}

// An unknown code is what a brute-force attempt looks like from here, so guesses
// are rationed far harder than ordinary traffic — that ration is what turns eight
// characters into a credential.
func TestUnknownCodeLimiterTrips(t *testing.T) {
	h := newHarness(t, nil)
	cs := h.agent()

	tripped := false
	for i := 0; i < 40 && !tripped; i++ {
		result := call(t, cs, "ideate_status", map[string]any{"code": fmt.Sprintf("GUESS%03d", i)})
		if !result.isError {
			t.Fatal("a guessed code succeeded")
		}
		tripped = strings.Contains(strings.ToLower(result.text), "too many attempts")
	}
	if !tripped {
		t.Fatal("the unknown-code limiter never tripped")
	}

	// And a real code still works: the limiter must ration guessing without
	// punishing the tab whose code is correct.
	tab := h.dialTab(testCode, protocol.Version)
	tab.expectReady()
	tab.pushState(sampleState())
	call(t, cs, "ideate_status", map[string]any{"code": testCode}).
		ok(t, "a known code after the limiter tripped")
}

/* ------------------------------------------------------------------ */
/* Failure modes of the socket                                         */
/* ------------------------------------------------------------------ */

// A timeout is a *tool error the agent can act on*, not a transport failure. An
// exception would reach the model with the useful part stripped off.
func TestRequestTimeout(t *testing.T) {
	h := newHarness(t, func(c *config.Config) { c.RequestTimeout = 300 * time.Millisecond })
	tab, cs := h.pair(testCode)

	// Deliberately never answered.
	go func() { _, _ = tab.nextRequest(5 * time.Second) }()

	call(t, cs, "ideate_check", map[string]any{"code": testCode}).failsWith(t, "did not answer")
}

// Anything in flight when the tab goes away will never be answered. Saying so beats
// letting the call burn its whole timeout for a reply that is not coming.
func TestTabClosesMidRequest(t *testing.T) {
	h := newHarness(t, func(c *config.Config) { c.RequestTimeout = 30 * time.Second })
	tab, cs := h.pair(testCode)

	go func() {
		if _, ok := tab.nextRequest(5 * time.Second); ok {
			tab.close()
		}
	}()

	start := time.Now()
	call(t, cs, "ideate_check", map[string]any{"code": testCode}).failsWith(t, "disconnected")
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("waited %s for an answer that could never come", elapsed)
	}
}

// A reload or a flaky network must not cost the agent its attachment, or every
// refresh would need the human to re-pair.
func TestGraceWindowRejoin(t *testing.T) {
	h := newHarness(t, nil)
	tab, cs := h.pair(testCode)
	tab.close()

	// The bucket survives, still attached.
	waitFor(t, "the tab to be released", func() bool {
		s := h.reg.Lookup(hashOf(testCode))
		return s != nil && !s.HasTab()
	})
	if attached, _ := h.reg.Lookup(hashOf(testCode)).Attached(); !attached {
		t.Fatal("the attachment was dropped when the socket did")
	}

	rejoined := h.dialTab(testCode, protocol.Version)
	rejoined.expectReady()
	// The re-sent `attached` is what keeps the toolbar honest: without it a
	// reloaded tab would show nobody attached while an agent carried on editing it.
	rejoined.expectFrame(protocol.TAttached)

	rejoined.answer(func(protocol.Command) any { return map[string]any{"diagnostics": []any{}} })
	call(t, cs, "ideate_check", map[string]any{"code": testCode}).
		ok(t, "a call after the tab rejoined")
}

func TestBucketExpiresAfterGrace(t *testing.T) {
	h := newHarness(t, func(c *config.Config) { c.TabGrace = 30 * time.Second })
	tab, _ := h.pair(testCode)
	tab.close()
	waitFor(t, "the tab to be released", func() bool {
		s := h.reg.Lookup(hashOf(testCode))
		return s != nil && !s.HasTab()
	})

	h.clock.Advance(31 * time.Second)
	h.reg.Sweep()

	if h.reg.Lookup(hashOf(testCode)) != nil {
		t.Fatal("the bucket outlived its grace window")
	}
}

/* ------------------------------------------------------------------ */
/* Capacity                                                            */
/* ------------------------------------------------------------------ */

func TestServiceFull(t *testing.T) {
	h := newHarness(t, func(c *config.Config) { c.MaxWSSessions = 1 })

	first := h.dialTab(testCode, protocol.Version)
	first.expectReady()

	second := h.dialTab("OTHERC0D", protocol.Version)
	second.expectClose(protocol.CloseServiceFull)

	// The capacity probe is where a client that can read a status code gets the
	// answer a browser never sees: a refused handshake reaches a tab as an
	// anonymous 1006, indistinguishable from the service being down.
	resp, err := http.Get(h.server.URL + protocol.CapacityPath)
	if err != nil {
		t.Fatalf("capacity probe: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != httpapi.StatusOverloaded {
		t.Fatalf("capacity status = %d, want %d", resp.StatusCode, httpapi.StatusOverloaded)
	}
	var body struct{ Live, Max int }
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if body.Live != 1 || body.Max != 1 {
		t.Fatalf("capacity body = %+v, want live 1 of 1", body)
	}
}

// A full service is a *healthy* service — it is doing exactly what it was configured to
// do. Gating liveness on capacity would have the platform restart the instance at
// the moment the most people were using it, dropping every live tab socket.
func TestHealthIgnoresCapacity(t *testing.T) {
	h := newHarness(t, func(c *config.Config) { c.MaxWSSessions = 1 })
	tab := h.dialTab(testCode, protocol.Version)
	tab.expectReady()

	resp, err := http.Get(h.server.URL + "/healthz")
	if err != nil {
		t.Fatalf("health probe: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d while full, want 200", resp.StatusCode)
	}
}

// Without reaping before refusing, a burst of connect/disconnect fills the cap with
// grace-window ghosts and locks out everybody real for thirty seconds at a time.
func TestExpiredBucketFreesItsSlot(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {
		c.MaxWSSessions = 1
		c.TabGrace = 30 * time.Second
	})

	first := h.dialTab(testCode, protocol.Version)
	first.expectReady()
	first.close()
	waitFor(t, "the first tab to be released", func() bool {
		s := h.reg.Lookup(hashOf(testCode))
		return s != nil && !s.HasTab()
	})

	// Still inside the grace window: the slot is genuinely reserved, because the
	// first tab may be reloading and must find its own bucket waiting.
	blocked := h.dialTab("OTHERC0D", protocol.Version)
	blocked.expectClose(protocol.CloseServiceFull)

	h.clock.Advance(31 * time.Second)

	// Now the ghost is collectable, and AdoptTab must collect it rather than refuse.
	// Note there is no Sweep() here on purpose — this asserts the reap that happens
	// on the refusal path, which is the one that matters under a burst.
	second := h.dialTab("OTHERC0D", protocol.Version)
	second.expectReady()
}

/* ------------------------------------------------------------------ */
/* In-flight budget                                                    */
/* ------------------------------------------------------------------ */

// The memory risk is many large frames at once, not idle sockets: 250 sockets at
// the 8MB frame limit is a 2GB spike on a 512MB box. The budget is taken before a
// payload is forwarded and released when the call settles, so a second large call
// waits rather than adding to the peak.
func TestInflightBudgetBlocksThenReleases(t *testing.T) {
	// The floor NewRegistry allows, so two ~5MB commands cannot both be in flight.
	h := newHarness(t, func(c *config.Config) {
		c.MaxInflightBytes = protocol.MaxFrameBytes
		c.RequestTimeout = 20 * time.Second
	})
	tab, cs := h.pair(testCode)

	bulk := strings.Repeat("x", 5<<20)

	first := make(chan toolCall, 1)
	go func() {
		first <- call(t, cs, "ideate_edit", map[string]any{
			"code":  testCode,
			"edits": []map[string]any{{"oldText": bulk, "newText": "small"}},
		})
	}()

	req, ok := tab.nextRequest(15 * time.Second)
	if !ok {
		t.Fatal("the first large command never reached the tab")
	}

	second := make(chan toolCall, 1)
	go func() {
		second <- call(t, cs, "ideate_edit", map[string]any{
			"code":  testCode,
			"edits": []map[string]any{{"oldText": bulk, "newText": "also small"}},
		})
	}()

	// It must not reach the tab while the first still holds the budget.
	if _, arrived := tab.nextRequest(1500 * time.Millisecond); arrived {
		t.Fatal("a second large command was forwarded while the budget was exhausted")
	}

	tab.reply(req.ID, map[string]any{"applied": 1, "lineCount": 1, "diagnostics": []any{}})
	(<-first).ok(t, "the first large edit")

	// Releasing the budget must let the waiter through, not merely stop blocking it.
	req2, ok := tab.nextRequest(15 * time.Second)
	if !ok {
		t.Fatal("the second command never went out after the budget was released")
	}
	tab.reply(req2.ID, map[string]any{"applied": 1, "lineCount": 1, "diagnostics": []any{}})
	(<-second).ok(t, "the second large edit")
}

/* ------------------------------------------------------------------ */
/* Tool-argument validation                                            */
/* ------------------------------------------------------------------ */

// Every one of these is something the agent can fix on its own, which is why they
// are tool errors carrying a message rather than protocol errors.
func TestSceneOpValidation(t *testing.T) {
	h := newHarness(t, nil)
	_, cs := h.pair(testCode)

	cases := []struct {
		name    string
		ops     []map[string]any
		mention string
	}{
		{"unknown op", []map[string]any{{"op": "move", "id": "a"}}, `use "add"`},
		{"add with no type", []map[string]any{{"op": "add", "x": 0.0, "y": 0.0}}, "no type"},
		{"add with a bad type", []map[string]any{{"op": "add", "type": "hexagon", "x": 0.0, "y": 0.0}}, "rectangle"},
		{"add with no position", []map[string]any{{"op": "add", "type": "rectangle"}}, "no x/y"},
		{"update with no id", []map[string]any{{"op": "update", "text": "hi"}}, "no id"},
		{"delete with no id", []map[string]any{{"op": "delete"}}, "no id"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			call(t, cs, "ideate_scene_edit", map[string]any{"code": testCode, "ops": tc.ops}).
				failsWith(t, tc.mention)
		})
	}

	// A bound arrow needs no coordinates of its own — the app routes it between the
	// two shapes — so requiring x/y there would refuse the most useful shape.
	h2 := newHarness(t, nil)
	tab, cs2 := h2.pair(testCode)
	tab.answer(func(protocol.Command) any { return map[string]any{"applied": 1, "elementCount": 3} })
	call(t, cs2, "ideate_scene_edit", map[string]any{
		"code": testCode,
		"ops":  []map[string]any{{"op": "add", "type": "arrow", "start": "a", "end": "b"}},
	}).ok(t, "a bound arrow with no coordinates")
}

// create_file refuses the one extension it could otherwise honour, and badly: a
// canvas's content is scene JSON no model should author, and omitting it opens an
// empty canvas nobody asked to look at.
func TestCreateFileRefusesACanvas(t *testing.T) {
	h := newHarness(t, nil)
	tab, cs := h.pair(testCode)

	call(t, cs, "ideate_create_file", map[string]any{"code": testCode, "path": ""}).
		failsWith(t, "empty")
	call(t, cs, "ideate_create_file", map[string]any{
		"code": testCode, "path": "canvas/new.excalidraw",
	}).failsWith(t, "ideate_create_canvas")
	// Case is not a way around it — fileKind lowercases too.
	call(t, cs, "ideate_create_file", map[string]any{
		"code": testCode, "path": "canvas/New.Excalidraw",
	}).failsWith(t, "ideate_create_canvas")
	if _, ok := tab.nextRequest(200 * time.Millisecond); ok {
		t.Fatal("a refused create_file still reached the tab")
	}

	tab.answer(func(cmd protocol.Command) any {
		if cmd.Cmd != protocol.CmdCreateFile {
			t.Errorf("tab was asked for %q", cmd.Cmd)
		}
		return map[string]any{"path": "notes/new.md", "created": true}
	})
	call(t, cs, "ideate_create_file", map[string]any{
		"code": testCode, "path": "notes/new.md",
	}).ok(t, "create_file for a document")
}

// create_canvas is the one tool that refuses a path outright rather than creating
// what it was given: the extension is what decides the editor, so a .md path here
// would produce a markdown document from a request to draw.
func TestCreateCanvasValidation(t *testing.T) {
	h := newHarness(t, nil)
	tab, cs := h.pair(testCode)

	call(t, cs, "ideate_create_canvas", map[string]any{"code": testCode, "path": ""}).
		failsWith(t, "empty")
	call(t, cs, "ideate_create_canvas", map[string]any{"code": testCode, "path": "notes/plan.md"}).
		failsWith(t, "not a canvas")
	// Bad ops are refused here, before the tab is asked to open anything — an
	// invalid drawing must not leave a blank canvas in the human's editor.
	call(t, cs, "ideate_create_canvas", map[string]any{
		"code": testCode,
		"path": "canvas/new.excalidraw",
		"ops":  []map[string]any{{"op": "add", "type": "hexagon", "x": 0.0, "y": 0.0}},
	}).failsWith(t, "rectangle")
	if _, ok := tab.nextRequest(200 * time.Millisecond); ok {
		t.Fatal("a refused create_canvas still reached the tab")
	}

	// No ops is a request for a blank canvas, not a malformed call.
	tab.answer(func(cmd protocol.Command) any {
		if cmd.Cmd != protocol.CmdCreateCanvas {
			t.Errorf("tab was asked for %q", cmd.Cmd)
		}
		if cmd.Ops != nil {
			t.Errorf("blank create_canvas forwarded %d ops", len(cmd.Ops))
		}
		return map[string]any{"path": "canvas/new.excalidraw", "created": true, "elementCount": 0}
	})
	call(t, cs, "ideate_create_canvas", map[string]any{
		"code": testCode, "path": "canvas/new.excalidraw",
	}).ok(t, "create_canvas with no ops")
}

func TestEditValidation(t *testing.T) {
	h := newHarness(t, nil)
	_, cs := h.pair(testCode)

	call(t, cs, "ideate_edit", map[string]any{"code": testCode, "edits": []map[string]any{}}).
		failsWith(t, "empty")
	call(t, cs, "ideate_edit", map[string]any{
		"code":  testCode,
		"edits": []map[string]any{{"oldText": "", "newText": "x"}},
	}).failsWith(t, "matches everywhere")
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// hashOf mirrors what the service does to a code before it ever indexes on it.
func hashOf(code string) string { return session.Hash(code) }

// waitFor polls a condition the service reaches asynchronously — a socket closing
// is observed by the read loop, not by the goroutine that closed it.
func waitFor(t *testing.T, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if done() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

/* ------------------------------------------------------------------ */
/* The operator's census                                               */
/* ------------------------------------------------------------------ */

const (
	statsPath = "/v1/stats"
	statsUser = "ops"
	statsPass = "s3cret-and-long-enough"
)

func withStatsAuth(c *config.Config) {
	c.StatsUser = statsUser
	c.StatsPassword = statsPass
}

// statsBody is the census response, typed rather than decoded into a map: the
// process figures are a nested object, so a map[string]int would fail on them —
// quietly, since the counts it *can* read still land.
type statsBody struct {
	Live     int `json:"live"`
	Max      int `json:"max"`
	WithTab  int `json:"withTab"`
	InGrace  int `json:"inGrace"`
	Attached int `json:"attached"`
	Process  struct {
		UptimeSeconds float64  `json:"uptimeSeconds"`
		CPUs          int      `json:"cpus"`
		CPUSeconds    *float64 `json:"cpuSeconds"`
		CPUPercent    *float64 `json:"cpuPercent"`
		RSSBytes      *uint64  `json:"rssBytes"`
		RuntimeBytes  uint64   `json:"runtimeBytes"`
		HeapBytes     uint64   `json:"heapBytes"`
		Goroutines    int      `json:"goroutines"`
	} `json:"process"`
}

func getStats(t *testing.T, h *harness, user, pass string) (int, statsBody) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, h.server.URL+statsPath, nil)
	if err != nil {
		t.Fatalf("stats request: %v", err)
	}
	if user != "" || pass != "" {
		req.SetBasicAuth(user, pass)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("stats probe: %v", err)
	}
	defer resp.Body.Close()
	body := statsBody{}
	// Only decoded on success: the 401 path answers with plain text.
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatalf("stats body: %v", err)
		}
	}
	return resp.StatusCode, body
}

// The counts, and the reason they are broken down: a bucket waiting out its grace
// window and a tab an agent is driving are both "live", and an operator staring at
// one number cannot tell a busy instance from a full one.
func TestStatsCountsSessions(t *testing.T) {
	h := newHarness(t, withStatsAuth)

	status, body := getStats(t, h, statsUser, statsPass)
	if status != http.StatusOK {
		t.Fatalf("stats status = %d, want 200", status)
	}
	if body.Live != 0 || body.Attached != 0 {
		t.Fatalf("idle stats = %+v, want nothing live", body)
	}

	tab, _ := h.pair(testCode)
	_, body = getStats(t, h, statsUser, statsPass)
	if body.Live != 1 || body.WithTab != 1 || body.Attached != 1 || body.InGrace != 0 {
		t.Fatalf("paired-and-attached stats = %+v, want live/withTab/attached 1 and inGrace 0", body)
	}

	// A dropped tab keeps its bucket for TAB_GRACE, and that is exactly the state
	// worth being able to see: still live, no tab, agent still holding it.
	tab.close()
	waitFor(t, "the dropped tab's bucket to show as in-grace", func() bool {
		_, body := getStats(t, h, statsUser, statsPass)
		return body.InGrace == 1 && body.WithTab == 0 && body.Live == 1
	})
}

// Credentials are the whole of the gate, so the ways of getting past it without any
// are worth stating.
func TestStatsRequiresCredentials(t *testing.T) {
	h := newHarness(t, withStatsAuth)

	if status, _ := getStats(t, h, "", ""); status != http.StatusUnauthorized {
		t.Errorf("no credentials = %d, want 401", status)
	}
	if status, _ := getStats(t, h, statsUser, "wrong"); status != http.StatusUnauthorized {
		t.Errorf("wrong password = %d, want 401", status)
	}
	if status, _ := getStats(t, h, "wrong", statsPass); status != http.StatusUnauthorized {
		t.Errorf("wrong user = %d, want 401", status)
	}
	if status, _ := getStats(t, h, statsUser, statsPass+"x"); status != http.StatusUnauthorized {
		t.Errorf("password prefix = %d, want 401", status)
	}
}

// What the instance is costing the box, alongside what it is holding. An operator
// reading this route is usually deciding whether to raise MAX_WS_SESSIONS or to add
// memory, and the counts alone cannot answer that.
//
// The CPU percentage covers one sweep interval and is advanced by the sweeper, not
// by this request — so it is absent until a sweep has happened, which is the state
// this asserts first.
func TestStatsReportsProcessCost(t *testing.T) {
	h := newHarness(t, withStatsAuth)

	_, body := getStats(t, h, statsUser, statsPass)
	if body.Process.RuntimeBytes == 0 || body.Process.HeapBytes == 0 {
		t.Errorf("memory = runtime %d / heap %d, want both non-zero",
			body.Process.RuntimeBytes, body.Process.HeapBytes)
	}
	if body.Process.CPUs < 1 || body.Process.Goroutines < 1 {
		t.Errorf("cpus = %d, goroutines = %d, want at least one of each",
			body.Process.CPUs, body.Process.Goroutines)
	}
	if body.Process.CPUPercent != nil {
		t.Errorf("cpuPercent = %v before any sweep, want absent", *body.Process.CPUPercent)
	}

	// One sweep interval of the injected clock, then the sweep the service's ticker
	// would have run.
	h.clock.Advance(10 * time.Second)
	h.api.Sweep()

	_, body = getStats(t, h, statsUser, statsPass)
	if body.Process.UptimeSeconds != 10 {
		t.Errorf("uptime = %v, want 10", body.Process.UptimeSeconds)
	}
	if body.Process.CPUSeconds == nil || body.Process.CPUPercent == nil {
		t.Fatalf("cpu after a sweep = %v/%v, want both present on this platform",
			body.Process.CPUSeconds, body.Process.CPUPercent)
	}
	// The window is ten seconds of fake time against real CPU time, so the only
	// honest bound is that it is a percentage and not a negative one.
	if *body.Process.CPUPercent < 0 {
		t.Errorf("cpuPercent = %v, want >= 0", *body.Process.CPUPercent)
	}
	if *body.Process.CPUSeconds <= 0 {
		t.Errorf("cpuSeconds = %v, want the process to have used some CPU by now",
			*body.Process.CPUSeconds)
	}
}

// With nothing configured the route does not exist. A 401 would still tell an
// unauthenticated caller that this instance has counts worth asking for, and an
// operator who never set STATS_USER never opted into publishing them at all.
func TestStatsAbsentWithoutCredentials(t *testing.T) {
	h := newHarness(t, nil)
	if status, _ := getStats(t, h, statsUser, statsPass); status != http.StatusNotFound {
		t.Errorf("stats with no credentials configured = %d, want 404", status)
	}
}

/* ------------------------------------------------------------------ */
/* The tool list                                                       */
/* ------------------------------------------------------------------ */

// The bug this fixes: the service is redeployed with a new tool, and an agent that
// listed the tools against the previous build never hears about it. Nothing in a
// request/response flow tells it, and a fresh process has no idea its own list is
// news to anybody — the only observable that says "somebody may be holding an older
// list" is a client subscribing.
//
// So a subscription has to be answered with a notification, and that is what this
// asserts. It also asserts the channel underneath it: a stateless server answers
// GET /mcp with 405, and subscriptions/listen is the only way a notification
// reaches a client here at all.
func TestSubscribingProvokesAToolListRefresh(t *testing.T) {
	h := newHarness(t, nil)
	_, changed := h.agentWatchingTools()

	select {
	case <-changed:
	case <-time.After(10 * time.Second):
		t.Fatal("no tools/list_changed after subscribing — a client that reconnected " +
			"after a deploy would keep using the tool list of the build it left")
	}
}

// A client that never subscribes cannot be told, so the recourse is that its agent
// can read the surface and say so out loud. Which makes the reported list load
// bearing: it has to be the list the server actually serves, or the agent's report
// is worse than nothing.
func TestStatusReportsTheToolSurface(t *testing.T) {
	h := newHarness(t, nil)
	tab := h.dialTab(testCode, protocol.Version)
	tab.expectReady()
	tab.pushState(sampleState())

	cs := h.agent()
	body := call(t, cs, "ideate_status", map[string]any{"code": testCode}).
		ok(t, "ideate_status").decode(t)

	service, _ := body["service"].(map[string]any)
	if service["build"] != testBuild {
		t.Errorf("service.build = %v, want %q", service["build"], testBuild)
	}
	reported := map[string]bool{}
	for _, name := range service["tools"].([]any) {
		reported[name.(string)] = true
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	served, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("tools/list: %v", err)
	}
	if len(served.Tools) != len(reported) {
		t.Errorf("status reported %d tools, tools/list serves %d", len(reported), len(served.Tools))
	}
	for _, tool := range served.Tools {
		if !reported[tool.Name] {
			t.Errorf("tools/list serves %q but status does not report it", tool.Name)
		}
	}
}
