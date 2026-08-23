// Package httpapi is the service's whole outward surface: the MCP endpoint an
// agent talks to, the WebSocket a browser tab dials, a capacity probe, and a
// liveness check.
//
// **There is no CORS configuration anywhere in here, and none should be added.**
// The two callers are a browser opening a WebSocket — which has no same-origin
// policy and so no preflight to satisfy — and an MCP client, which is not a
// browser at all. A CORS header here would be answering a question nobody asked.
//
// That is a real change from protocol 2, where the *absence* of CORS headers on
// the app's token route was the load-bearing security property. There is no token
// route any more: the tab generates its own pairing code, the service issues
// nothing and merely buckets by its hash, and a hostile page that generates its own
// code can only pair with itself.
package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hasathcharu/ideate/ideate-relay/internal/config"
	"github.com/hasathcharu/ideate/ideate-relay/internal/procstat"
	"github.com/hasathcharu/ideate/ideate-relay/internal/protocol"
	"github.com/hasathcharu/ideate/ideate-relay/internal/ratelimit"
	"github.com/hasathcharu/ideate/ideate-relay/internal/session"
)

// StatusOverloaded is served by the capacity probe when the relay is full.
//
// It exists because a browser can never see it. A *refused* WebSocket handshake
// surfaces in the tab as onclose 1006 with an empty reason, which is
// indistinguishable from the service being down — so the tab is told about
// capacity by CloseRelayFull on an accepted socket instead, and this route is where
// a client that can read a status code gets the readable answer.
const StatusOverloaded = 529

// tabPingInterval keeps an idle socket alive through whatever proxies sit in
// front. A tab can hold a bucket for days without an agent ever attaching, and an
// intermediary that drops quiet connections after a minute would turn that into a
// reconnect loop.
const tabPingInterval = 30 * time.Second

// Options is what New needs. Everything not listed is derived.
type Options struct {
	Config   config.Config
	Registry *session.Registry
	// MCP is the server holding the twelve tools. It is wrapped in a Streamable
	// HTTP handler here rather than by the caller, so the transport decisions stay
	// with the rest of the HTTP concerns.
	MCP    *mcp.Server
	Logger *slog.Logger
	// BaseContext is cancelled on shutdown, which is what closes live tab sockets.
	// A tab socket must not hang off its own request context: for HTTP/1.1 the
	// connection is hijacked out from under the server, so nothing else would ever
	// cancel it.
	BaseContext context.Context
	// Now is the clock the CPU-usage window is measured against. Nil means
	// time.Now; it is here so a test can advance it instead of sleeping.
	Now func() time.Time
}

// Server routes the four endpoints.
type Server struct {
	cfg     config.Config
	reg     *session.Registry
	log     *slog.Logger
	baseCtx context.Context
	mcpHTTP http.Handler
	general *ratelimit.Limiter
	unknown *ratelimit.Limiter
	proc    *procstat.Sampler
}

// Rate limits.
//
// The general one is deliberately loose: an agent issues a call every few seconds,
// but a whole office can arrive from one NAT address, so this is set to catch a
// runaway rather than to shape traffic.
//
// The unknown-code one is the tight one, and it is what turns 8 characters of
// Crockford base32 into a credential. 2^40 at a guess every five seconds is a
// number of years with six digits in it.
// statsPath is the operator's census endpoint.
//
// It lives here rather than in internal/protocol because no browser tab ever calls
// it: everything in that package is mirrored by hand in app/lib/agentProtocol.ts and
// owes a fixture in testdata/frames, and an operator-only route has no business
// taking on that obligation.
const statsPath = "/v1/stats"

const (
	generalPerSecond = 10
	generalBurst     = 60
	unknownPerSecond = 0.2
	unknownBurst     = 10
)

// New builds the router's backing server.
func New(opts Options) (*Server, error) {
	if opts.Registry == nil || opts.MCP == nil {
		return nil, errors.New("httpapi: Registry and MCP are required")
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.BaseContext == nil {
		opts.BaseContext = context.Background()
	}
	s := &Server{
		cfg:     opts.Config,
		reg:     opts.Registry,
		log:     opts.Logger,
		baseCtx: opts.BaseContext,
		general: ratelimit.New(generalPerSecond, generalBurst),
		unknown: ratelimit.New(unknownPerSecond, unknownBurst),
		proc:    procstat.NewSampler(opts.Now),
	}
	s.mcpHTTP = mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return opts.MCP },
		&mcp.StreamableHTTPOptions{
			// Stateless: every request carries its own pairing code, so there is
			// nothing for an Mcp-Session-Id to identify that the code does not
			// already. Dropping the session map takes a whole lifecycle with it —
			// and the attachment idle timeout, which a stateful server would have
			// got for free from client teardown, is wanted anyway: a client can
			// vanish without ever tearing down cleanly.
			Stateless: true,
			Logger:    opts.Logger,
			// The SDK applies its own body limit (4MiB by default) *before* the
			// handler sees anything, so MAX_BODY_BYTES has to be set here or it
			// silently does nothing and the smaller default quietly wins. Wrapping
			// the body in a second MaxBytesReader of our own does not fix that —
			// the tighter of the two limits is always the one that speaks, and two
			// limits with different numbers means a 413 that names neither.
			MaxRequestBodyBytes: opts.Config.MaxBodyBytes,
		},
	)
	return s, nil
}

// UnknownCodeLimiter is handed to the tool layer, which is the only place that can
// tell an unknown code from a known one.
func (s *Server) UnknownCodeLimiter() *ratelimit.Limiter { return s.unknown }

// Handler builds the router.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/mcp", s.rateLimited(http.HandlerFunc(s.handleMCP)))
	mux.Handle("GET "+protocol.TabPath, s.rateLimited(http.HandlerFunc(s.handleTab)))
	mux.HandleFunc("GET "+protocol.CapacityPath, s.handleCapacity)
	// Rate limited like the public routes, since basic auth is a thing you can
	// guess at, and the general bucket is what makes guessing cost something.
	mux.Handle("GET "+statsPath, s.rateLimited(s.statsAuth(http.HandlerFunc(s.handleStats))))
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("/", s.handleRoot)
	return mux
}

// Sweep drops idle rate-limiter keys and advances the CPU-usage window. Called
// from the same ticker as the registry's.
//
// The CPU sample rides along here rather than being taken per request so that the
// percentage always covers one sweep interval, whoever is polling and however often
// — see procstat.Sampler.
func (s *Server) Sweep() {
	s.general.Sweep()
	s.unknown.Sweep()
	s.proc.Sample()
}

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */

// rateLimited rations by client address and carries that address onward.
//
// It runs **before** the body is read, and it has to: the pairing code arrives as a
// tool argument, so nothing can be keyed on it until the request has already been
// parsed — which is the work this exists to avoid paying for. The per-IP limit is
// therefore what guards against a flood, and the code's own length is what guards
// against a guess.
func (s *Server) rateLimited(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := ratelimit.ClientIP(r)
		if !s.general.Allow(ip) {
			w.Header().Set("Retry-After", "5")
			http.Error(w, "Too many requests.", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r.WithContext(ratelimit.WithClientIP(r.Context(), ip)))
	})
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

// handleMCP is a thin pass-through: the body limit lives in the SDK's options (see
// New), and rate limiting has already run in the middleware. It exists so the route
// has somewhere to grow.
func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	s.mcpHTTP.ServeHTTP(w, r)
}

/* ------------------------------------------------------------------ */
/* Tab socket                                                          */
/* ------------------------------------------------------------------ */

func (s *Server) handleTab(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if !s.cfg.OriginAllowed(origin) {
		// A soft allowlist: it stops the service being used as free infrastructure
		// by pages that have nothing to do with Ideate. It is *not* the security
		// control — a browser cannot forge Origin but a local process can, and
		// neither can guess a pairing code, which is what actually matters.
		s.log.Info("tab handshake refused", "origin", origin)
		http.Error(w, "Origin not allowed.", http.StatusForbidden)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Our own check ran above. The library's OriginPatterns cannot express
		// "any localhost port", which a dev server needs, and refusing here would
		// lose the log line that says which origin was turned away.
		InsecureSkipVerify: true,
	})
	if err != nil {
		s.log.Info("tab upgrade failed", "error", err)
		return
	}
	// Read one byte past the limit so an oversized frame can be *detected* and
	// answered with CloseFrameTooLarge, rather than tripping the socket's own limit
	// and closing with the protocol's generic 1009.
	conn.SetReadLimit(protocol.MaxFrameBytes + 1)
	defer conn.CloseNow()

	ctx, cancel := context.WithCancel(s.baseCtx)
	defer cancel()

	code, ok := s.readHello(ctx, conn)
	if !ok {
		return
	}

	codeHash := session.Hash(code)
	sess, rejoinedAttached, err := s.reg.AdoptTab(codeHash, conn)
	if err != nil {
		switch {
		case errors.Is(err, session.ErrSlotTaken):
			closeWith(conn, websocket.StatusCode(protocol.CloseSlotTaken),
				"Another browser tab already holds this pairing code. Switch Agent Link "+
					"off in that tab, or regenerate the code here.")
		case errors.Is(err, session.ErrRelayFull):
			// Delivered on an accepted socket rather than as a refused handshake —
			// see StatusOverloaded.
			closeWith(conn, websocket.StatusCode(protocol.CloseRelayFull),
				"The shared Agent Link service is at capacity. Run your own — it is a "+
					"single binary — and point this tab at it in Advanced options.")
		default:
			closeWith(conn, websocket.StatusInternalError, "Could not pair this tab.")
		}
		return
	}
	defer s.reg.ReleaseTab(sess, conn)

	if err := writeFrame(ctx, conn, protocol.NewReady()); err != nil {
		return
	}
	if rejoinedAttached {
		// A reload inside the grace window comes back to a bucket an agent still
		// holds. Without this the tab would show nobody attached while an agent
		// carried on editing it, which is the one thing the attached/paired split
		// exists to prevent.
		_, agent := sess.Attached()
		if err := writeFrame(ctx, conn, protocol.NewAttached(agent)); err != nil {
			return
		}
	}

	go s.keepAlive(ctx, conn)
	s.readLoop(ctx, conn, sess)
}

// readHello waits for the tab's first frame. Anything else, or nothing at all
// inside the deadline, and the socket is dropped rather than left holding a slot.
func (s *Server) readHello(ctx context.Context, conn *websocket.Conn) (string, bool) {
	// The deadline is a timer beside the read, not a context *on* it. Cancelling a
	// context mid-read makes coder/websocket tear the connection down itself —
	// there is no way to resynchronize a half-read frame — so a Close afterwards is
	// a no-op and the tab sees a bare 1006 instead of CloseBadHello. That is the
	// difference between "the service refused my hello" and "the service is down",
	// which is the whole reason these private-use codes exist.
	type readResult struct {
		raw []byte
		err error
	}
	done := make(chan readResult, 1)
	go func() {
		_, raw, err := conn.Read(ctx)
		done <- readResult{raw, err}
	}()

	var raw []byte
	select {
	case got := <-done:
		if got.err != nil {
			closeWith(conn, websocket.StatusCode(protocol.CloseBadHello),
				"The socket closed before a hello frame arrived.")
			return "", false
		}
		raw = got.raw
	case <-time.After(protocol.HelloDeadline):
		closeWith(conn, websocket.StatusCode(protocol.CloseBadHello),
			"No hello frame arrived in time.")
		return "", false
	}
	if len(raw) > protocol.MaxFrameBytes {
		closeWith(conn, websocket.StatusCode(protocol.CloseFrameTooLarge), "Frame too large.")
		return "", false
	}

	var hello protocol.Hello
	if protocol.Tag(raw) != protocol.THello || json.Unmarshal(raw, &hello) != nil {
		closeWith(conn, websocket.StatusCode(protocol.CloseBadHello), "First frame was not a hello.")
		return "", false
	}
	if hello.Protocol != protocol.Version {
		// Retrying cannot fix a version mismatch and the tab stops trying on this
		// code, so the message has to be enough to act on by itself.
		closeWith(conn, protocol.CloseProtocolMismatch, truncateReason(
			"Agent Link protocol "+strconv.Itoa(hello.Protocol)+" vs "+strconv.Itoa(protocol.Version)+
				". Update whichever side is older."))
		return "", false
	}
	if session.Normalize(hello.Code) == "" {
		closeWith(conn, websocket.StatusCode(protocol.CloseBadHello), "The hello frame carried no pairing code.")
		return "", false
	}
	return hello.Code, true
}

func (s *Server) readLoop(ctx context.Context, conn *websocket.Conn, sess *session.Session) {
	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if len(raw) > protocol.MaxFrameBytes {
			closeWith(conn, websocket.StatusCode(protocol.CloseFrameTooLarge), "Frame too large.")
			return
		}
		switch protocol.Tag(raw) {
		case protocol.TRes:
			var res protocol.Result
			if json.Unmarshal(raw, &res) == nil {
				sess.Settle(res)
			}
		case protocol.TEvent:
			var event protocol.StateEvent
			if json.Unmarshal(raw, &event) == nil && event.Name == "state" {
				sess.SetState(event.State)
			}
		}
		// Anything else, including a second hello, is ignored rather than fatal.
		// The tab is not hostile; a frame this build does not know is a frame from
		// a slightly different build, and dropping the connection over it would be
		// worse than dropping the frame.
	}
}

func (s *Server) keepAlive(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(tabPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

/* ------------------------------------------------------------------ */
/* Probes                                                              */
/* ------------------------------------------------------------------ */

// statsAuth gates the census endpoint on basic auth.
//
// With no credentials configured the route **does not exist** rather than being open
// or answering 401: an operator who never set STATS_USER has not opted into
// publishing these counts, and a 401 would still tell an unauthenticated caller that
// this instance has numbers worth asking for.
func (s *Server) statsAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.StatsUser == "" || s.cfg.StatsPassword == "" {
			http.NotFound(w, r)
			return
		}
		user, pass, ok := r.BasicAuth()
		// Both halves are compared, and compared in constant time, before either
		// verdict is read — an early return on the username would time-leak which
		// half was wrong.
		userOK := subtle.ConstantTimeCompare([]byte(user), []byte(s.cfg.StatsUser)) == 1
		passOK := subtle.ConstantTimeCompare([]byte(pass), []byte(s.cfg.StatsPassword)) == 1
		if !ok || !userOK || !passOK {
			w.Header().Set("WWW-Authenticate", `Basic realm="ideate relay stats", charset="UTF-8"`)
			http.Error(w, "Unauthorized.", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// statsResponse is the census plus what the process is costing the box.
//
// session.Stats is **embedded**, so its fields stay at the top level of the JSON
// and a caller that already reads live/max/withTab/inGrace/attached keeps working.
// The process figures are nested instead of flattened because they answer a
// different question — "is this instance healthy" rather than "is it busy" — and
// because a name like `total` means something else on each side.
type statsResponse struct {
	session.Stats
	Process procstat.Snapshot `json:"process"`
}

// handleStats answers how many relay sessions this process is handling right now,
// and what that is costing it.
//
// Unlike /v1/capacity — which exists so a client can find out whether pairing will
// work at all, and is therefore public — this breaks the number down, so it is the
// operator's view: see session.Stats for why the halves are worth separating, and
// procstat for why the CPU number does not come from runtime/metrics.
func (s *Server) handleStats(w http.ResponseWriter, _ *http.Request) {
	// The counts change by the second and the response is credentialed. Nothing
	// should be holding a copy of it, least of all a CDN sitting in front.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, statsResponse{
		Stats:   s.reg.Stats(),
		Process: s.proc.Snapshot(),
	})
}

func (s *Server) handleCapacity(w http.ResponseWriter, _ *http.Request) {
	live, max := s.reg.Live(), s.reg.Max()
	status := http.StatusOK
	if live >= max {
		status = StatusOverloaded
	}
	writeJSON(w, status, map[string]any{"live": live, "max": max})
}

// handleHealth is deliberately **not** gated on capacity. A full relay is a healthy
// relay — it is doing exactly what it was configured to do — and a health check that
// failed on load would have the platform restart the instance, dropping every live
// tab socket at the precise moment the most people were using it.
func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "protocol": protocol.Version})
}

func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	// Answering rather than 404ing makes a browser pointed here by mistake — which
	// is the common way to check whether a service is up — say something useful.
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(
		"Ideate Agent Link.\n\n" +
			"  POST /mcp           MCP (Streamable HTTP) — point your agent here\n" +
			"  GET  " + protocol.TabPath + "        browser tab WebSocket\n" +
			"  GET  " + protocol.CapacityPath + "   {live, max}\n" +
			"  GET  /healthz       liveness\n"))
}

/* ------------------------------------------------------------------ */

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeFrame(ctx context.Context, conn *websocket.Conn, frame any) error {
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return conn.Write(writeCtx, websocket.MessageText, payload)
}

func closeWith(conn *websocket.Conn, code websocket.StatusCode, reason string) {
	_ = conn.Close(code, truncateReason(reason))
}

// truncateReason keeps a close reason inside the protocol's 123-byte limit. Over
// it, Close returns an error instead of closing, which would leave the socket open
// and the tab waiting for a verdict that never comes.
func truncateReason(reason string) string {
	const limit = 123
	if len(reason) <= limit {
		return reason
	}
	// Cut on a rune boundary so the truncated reason is still valid UTF-8.
	cut := limit - 3
	for cut > 0 && !utf8.RuneStart(reason[cut]) {
		cut--
	}
	return reason[:cut] + "..."
}
