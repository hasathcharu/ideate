// Package session holds the pairing registry: which browser tabs are connected,
// which agent (if any) has claimed each, and the routing of one command from an
// MCP tool call to the tab that answers it.
//
// This state is why the service is a single process and is not going to stop being
// one. The registry of live tab sockets is irreducible — a socket lives in the
// process that accepted it — and both halves of a pairing must be in one process
// to be piped together. So there is no Redis, no Postgres, and equally no
// horizontal scaling without sharding by code. One instance is correct for a long
// time, and the capacity cap is what keeps that honest.
//
// There is no datastore for the same reason there is no cluster: nothing here is
// durable. Every record describes a connection, and if the process dies the
// connections die with it, so a store would be preserving rows about sockets that
// no longer exist.
package session

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/sync/semaphore"

	"github.com/hasathcharu/ideate/ideate-relay/internal/protocol"
)

// Errors the WebSocket handler turns into close codes, and the tools turn into
// readable tool errors.
var (
	// ErrSlotTaken means a tab already holds this code's bucket.
	ErrSlotTaken = errors.New("another tab already holds this pairing code")
	// ErrRelayFull means the service is at MaxSessions.
	ErrRelayFull = errors.New("the relay is at capacity")
	// ErrNoTab means the bucket exists but its tab is inside the grace window.
	ErrNoTab = errors.New("no tab is connected for this pairing code")
	// ErrNotAttached means no agent has called ideate_connect on this bucket.
	ErrNotAttached = errors.New("not attached")
	// ErrBusy means the in-flight byte budget or the per-session call limit is
	// exhausted. Retryable, unlike everything else here.
	ErrBusy = errors.New("the relay is busy")
)

// maxPendingPerSession bounds how many commands one bucket can have in flight.
//
// The byte budget alone does not bound this: a one-line ideate_scene_get costs
// almost nothing to send and can return the whole scene, so an agent fanning out a
// hundred cheap calls buys a hundred expensive answers. A human-driven agent never
// has more than a couple outstanding, so this only ever catches a runaway.
const maxPendingPerSession = 8

// Options configures a Registry. Every duration comes from internal/config.
type Options struct {
	MaxSessions       int
	TabGrace          time.Duration
	AttachIdleTimeout time.Duration
	RequestTimeout    time.Duration
	MaxInflightBytes  int64
	Logger            *slog.Logger
	// Now is injectable so the grace window and the idle timeout can be tested
	// without sleeping through them.
	Now func() time.Time
}

// Registry maps a hashed pairing code to the tab holding it.
type Registry struct {
	opts Options

	mu     sync.Mutex
	byCode map[string]*Session

	// inFlight is a global budget for forwarded command payloads, in bytes.
	// Acquired before a command goes out and released once it settles.
	inFlight *semaphore.Weighted
}

// NewRegistry builds a registry, or fails on a configuration that could deadlock.
func NewRegistry(opts Options) (*Registry, error) {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.MaxSessions <= 0 {
		return nil, errors.New("session: MaxSessions must be positive")
	}
	// A budget smaller than one frame is not merely tight: semaphore.Acquire for a
	// weight above the total never succeeds, so every command would wait out its
	// whole timeout and report a mysterious "busy". Refuse at startup instead.
	if opts.MaxInflightBytes < protocol.MaxFrameBytes {
		return nil, fmt.Errorf(
			"session: MAX_INFLIGHT_BYTES (%d) must be at least one frame (%d), or every "+
				"command large enough to matter would block until it timed out",
			opts.MaxInflightBytes, protocol.MaxFrameBytes)
	}
	return &Registry{
		opts:     opts,
		byCode:   make(map[string]*Session),
		inFlight: semaphore.NewWeighted(opts.MaxInflightBytes),
	}, nil
}

// Live is the number of buckets held, which is what MaxSessions caps and what
// /v1/capacity reports.
//
// A bucket inside its grace window still counts. It is reserving the slot its tab
// is coming back to, so releasing it early would mean a reloading tab could find
// its own place taken by someone else — but it is also why AdoptTab reaps expired
// buckets *before* refusing, or a burst of connect/disconnect would fill the cap
// with thirty-second ghosts and lock out everybody real.
func (r *Registry) Live() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.byCode)
}

// Stats is a point-in-time census of the buckets, for the operator's endpoint.
//
// It reports the two halves of "how many sessions is this process handling"
// separately, because they answer different questions and Live alone hides both:
// WithTab is how many browser tabs are actually connected right now, InGrace is how
// many buckets are holding a slot for a tab that dropped and may be back, and
// Attached is how many of them an agent is driving. A box that looks busy but has
// nothing attached is a very different situation from one that is genuinely in use.
type Stats struct {
	Live     int `json:"live"`
	Max      int `json:"max"`
	WithTab  int `json:"withTab"`
	InGrace  int `json:"inGrace"`
	Attached int `json:"attached"`
}

// Stats counts the live buckets. Cheap enough to poll: it is one pass over a map
// that MaxSessions already bounds.
func (r *Registry) Stats() Stats {
	r.mu.Lock()
	defer r.mu.Unlock()
	// r.mu then s.mu, the same order Sweep takes them in.
	out := Stats{Live: len(r.byCode), Max: r.opts.MaxSessions}
	for _, s := range r.byCode {
		if s.HasTab() {
			out.WithTab++
		} else {
			out.InGrace++
		}
		if attached, _ := s.Attached(); attached {
			out.Attached++
		}
	}
	return out
}

// Max is the configured cap.
func (r *Registry) Max() int { return r.opts.MaxSessions }

// Lookup returns the bucket for a hashed code, or nil. Tools use this to tell an
// unknown code (ask the human for it) from a known one with no tab (switch Agent
// Link on) — two different things for the agent to say.
func (r *Registry) Lookup(codeHash string) *Session {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.byCode[codeHash]
}

// AdoptTab hands a freshly-helloed socket its bucket, creating one if needed.
//
// The bool reports a rejoin into a bucket an agent still holds — the caller has to
// re-send `attached`, or a reloaded tab would show nobody attached while an agent
// carried on editing it.
func (r *Registry) AdoptTab(codeHash string, conn *websocket.Conn) (*Session, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if existing, ok := r.byCode[codeHash]; ok {
		attached, err := existing.adopt(conn)
		if err != nil {
			return nil, false, err
		}
		r.opts.Logger.Info("tab rejoined", "code", LogKey(codeHash), "attached", attached)
		return existing, attached, nil
	}

	if len(r.byCode) >= r.opts.MaxSessions {
		r.reapLocked()
		if len(r.byCode) >= r.opts.MaxSessions {
			return nil, false, ErrRelayFull
		}
	}

	s := &Session{
		reg:      r,
		codeHash: codeHash,
		conn:     conn,
		pending:  make(map[int64]chan protocol.Result),
	}
	r.byCode[codeHash] = s
	r.opts.Logger.Info("tab paired", "code", LogKey(codeHash), "live", len(r.byCode))
	return s, false, nil
}

// ReleaseTab is called when a tab's read loop ends. The bucket survives for
// TabGrace so a reload or a flaky network does not cost the agent its attachment;
// Sweep drops it after that.
func (r *Registry) ReleaseTab(s *Session, conn *websocket.Conn) {
	if s.release(conn, r.opts.Now()) {
		r.opts.Logger.Info("tab disconnected", "code", LogKey(s.codeHash),
			"grace", r.opts.TabGrace)
	}
}

// Sweep drops buckets whose grace has expired and detaches agents that have gone
// quiet. Run on a ticker by the caller; also called from AdoptTab when at capacity.
func (r *Registry) Sweep() {
	r.mu.Lock()
	stale := r.reapLocked()
	idle := make([]*Session, 0, 2)
	for _, s := range r.byCode {
		if s.idleAttached(r.opts.Now(), r.opts.AttachIdleTimeout) {
			idle = append(idle, s)
		}
	}
	r.mu.Unlock()

	for _, hash := range stale {
		r.opts.Logger.Info("bucket expired", "code", LogKey(hash))
	}
	// Detaching writes to the socket, so it happens outside the registry lock. The
	// message says why, because from the human's side an attachment vanishing on
	// its own is otherwise indistinguishable from a bug.
	for _, s := range idle {
		s.Detach("The agent stopped making calls, so the attachment expired.")
		r.opts.Logger.Info("attachment idled out", "code", LogKey(s.codeHash))
	}
}

// reapLocked drops every bucket whose tab has been gone longer than the grace
// window. Callers hold r.mu.
func (r *Registry) reapLocked() []string {
	now := r.opts.Now()
	var dropped []string
	for hash, s := range r.byCode {
		if s.expired(now, r.opts.TabGrace) {
			delete(r.byCode, hash)
			dropped = append(dropped, hash)
		}
	}
	return dropped
}
