package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/hasathcharu/ideate/ideate-relay/internal/protocol"
)

// Session is one pairing bucket: at most one browser tab, and at most one agent
// attached to it.
//
// **Paired is not attached, and conflating the two makes the toolbar lie.** A tab
// holding a bucket has answered the question "which tab" — the human answered it
// by switching Agent Link on there. Whether to drive that tab is a separate
// question, answered by the agent calling ideate_connect, and until it does,
// nothing here can read or change the document. The reason for the split is that
// this process is not started by anybody's decision: an agent session starting is
// not a human choosing to hand over their open document.
type Session struct {
	reg      *Registry
	codeHash string

	mu sync.Mutex
	// conn is nil while the tab is inside its grace window. The bucket outlives
	// the socket; the socket does not outlive the bucket.
	conn      *websocket.Conn
	lastState *protocol.BridgeState
	attached  bool
	agent     string
	lastCall  time.Time
	// tabGone is zero while a tab is connected, and the moment it dropped
	// otherwise. It is the grace clock.
	tabGone time.Time
	pending map[int64]chan protocol.Result
	nextID  int64

	// writeMu serializes socket writes. Commands are forwarded from whichever
	// goroutine is serving an MCP request, while the read loop and the reaper can
	// both write too — and a WebSocket admits exactly one writer at a time.
	writeMu sync.Mutex
}

// adopt attaches a new socket to an existing bucket, or refuses if one is already
// there. Reports whether an agent still holds the bucket, so the caller can re-send
// `attached`.
func (s *Session) adopt(conn *websocket.Conn) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil {
		// Newest-wins would let anything that guessed a code silently displace the
		// human's real editor, which is the one outcome worth being rude about.
		return false, ErrSlotTaken
	}
	s.conn = conn
	s.tabGone = time.Time{}
	return s.attached, nil
}

// release detaches a socket, opening the grace window. Reports whether this call is
// the one that did it — a socket superseded by a newer one must not reopen it.
func (s *Session) release(conn *websocket.Conn, now time.Time) bool {
	s.mu.Lock()
	if s.conn != conn {
		s.mu.Unlock()
		return false
	}
	s.conn = nil
	s.tabGone = now
	waiters := s.drainPendingLocked()
	s.mu.Unlock()

	// Anything in flight will never be answered. Saying so beats letting each call
	// burn its whole timeout for an answer that is not coming.
	fail(waiters, "The tab disconnected before answering. It may be reloading; try again.")
	return true
}

func (s *Session) expired(now time.Time, grace time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn == nil && !s.tabGone.IsZero() && now.Sub(s.tabGone) > grace
}

func (s *Session) idleAttached(now time.Time, timeout time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.attached && !s.lastCall.IsZero() && now.Sub(s.lastCall) > timeout
}

// HasTab reports whether a tab is connected right now (as opposed to a bucket
// waiting out its grace window).
func (s *Session) HasTab() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn != nil
}

// Attached reports whether an agent holds this bucket, and what it called itself.
func (s *Session) Attached() (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.attached, s.agent
}

// State is the tab's last pushed BridgeState, or nil.
//
// Readable while merely paired: it is metadata about *which* document is open,
// never its content, and it is exactly what an agent needs in order to say what
// attaching would give it before attaching. Content stays behind Attach.
func (s *Session) State() *protocol.BridgeState {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastState == nil {
		return nil
	}
	copied := *s.lastState
	return &copied
}

// SetState records a pushed state event.
func (s *Session) SetState(state protocol.BridgeState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastState = &state
}

// Attach claims the tab for an agent.
//
// Re-attaching under the same name is idempotent, and a different name is refused.
// The refusal is not a security boundary — anyone holding the code could have
// attached first — it is there so two agents cannot quietly fight over one
// document. Idempotence is what lets an agent that restarted, or lost track of its
// own state, pick up where it was instead of waiting out the idle timeout.
func (s *Session) Attach(agent string) (*protocol.BridgeState, error) {
	s.mu.Lock()
	if s.conn == nil {
		s.mu.Unlock()
		return nil, ErrNoTab
	}
	if s.attached && s.agent != agent {
		held := s.agent
		s.mu.Unlock()
		if held == "" {
			held = "another agent"
		}
		return nil, fmt.Errorf(
			"%s is already attached to this tab. Ask the human for a different tab's "+
				"pairing code, or call ideate_disconnect first if that was you", held)
	}
	s.attached = true
	s.agent = agent
	s.lastCall = s.reg.opts.Now()
	state := s.lastState
	s.mu.Unlock()

	if err := s.push(protocol.NewAttached(agent)); err != nil {
		return nil, err
	}
	if state == nil {
		return nil, nil
	}
	copied := *state
	return &copied, nil
}

// Detach lets go without dropping the socket, so the tab stays paired and a later
// Attach needs nothing from the human.
func (s *Session) Detach(reason string) {
	s.mu.Lock()
	if !s.attached {
		s.mu.Unlock()
		return
	}
	s.attached = false
	s.agent = ""
	s.lastCall = time.Time{}
	waiters := s.drainPendingLocked()
	s.mu.Unlock()

	if reason == "" {
		reason = "The agent detached."
	}
	fail(waiters, reason)
	_ = s.push(protocol.NewDetached())
}

// Touch records activity against the idle clock. Called for every tool that
// requires attachment, including the ones that answer without a round trip.
func (s *Session) Touch() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.attached {
		s.lastCall = s.reg.opts.Now()
	}
}

// Call sends one command to the tab and waits for its answer.
//
// Every failure here is written to be read by an agent rather than by an operator,
// because every one of them is something the agent can act on: reconnect, wait,
// ask the human to switch something on. A timeout in particular is a tool error,
// not a transport error — the agent should be told the tab did not answer, not
// handed a broken pipe.
func (s *Session) Call(ctx context.Context, cmd protocol.Command) (json.RawMessage, error) {
	s.mu.Lock()
	if !s.attached {
		s.mu.Unlock()
		return nil, ErrNotAttached
	}
	if s.conn == nil {
		s.mu.Unlock()
		return nil, ErrNoTab
	}
	if len(s.pending) >= maxPendingPerSession {
		s.mu.Unlock()
		return nil, fmt.Errorf("%w: %d commands are already in flight for this tab",
			ErrBusy, maxPendingPerSession)
	}
	s.nextID++
	id := s.nextID
	answer := make(chan protocol.Result, 1)
	s.pending[id] = answer
	s.lastCall = s.reg.opts.Now()
	s.mu.Unlock()

	defer s.forget(id)

	payload, err := json.Marshal(protocol.NewRequest(id, cmd))
	if err != nil {
		return nil, fmt.Errorf("could not encode the %s command: %w", cmd.Cmd, err)
	}
	if len(payload) > protocol.MaxFrameBytes {
		return nil, fmt.Errorf(
			"the %s command is %d bytes, over the %d-byte frame limit",
			cmd.Cmd, len(payload), protocol.MaxFrameBytes)
	}

	timeout := s.reg.opts.RequestTimeout
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// The budget is taken before the payload goes anywhere, and held until the call
	// settles, so what it bounds is bytes actually resident in this process rather
	// than bytes that have merely been counted.
	weight := int64(len(payload))
	if err := s.reg.inFlight.Acquire(ctx, weight); err != nil {
		return nil, fmt.Errorf(
			"%w: too much data is in flight across the relay right now. This is "+
				"temporary — try the same call again", ErrBusy)
	}
	defer s.reg.inFlight.Release(weight)

	if err := s.write(ctx, payload); err != nil {
		return nil, fmt.Errorf("could not reach the tab: %w", err)
	}

	select {
	case res := <-answer:
		if !res.OK {
			return nil, errors.New(res.Message)
		}
		return res.Data, nil
	case <-ctx.Done():
		return nil, fmt.Errorf(
			"the tab did not answer %q within %s. It may be busy, or the page may have "+
				"been reloaded", cmd.Cmd, timeout)
	}
}

// Settle delivers an answer to whichever Call is waiting for it. An id nobody is
// waiting for is dropped: it is a late answer to a call that already timed out.
func (s *Session) Settle(res protocol.Result) {
	s.mu.Lock()
	answer, ok := s.pending[res.ID]
	if ok {
		delete(s.pending, res.ID)
	}
	s.mu.Unlock()
	if ok {
		answer <- res
	}
}

func (s *Session) forget(id int64) {
	s.mu.Lock()
	delete(s.pending, id)
	s.mu.Unlock()
}

// drainPendingLocked takes every waiter and empties the map. Callers hold s.mu and
// must resolve the returned channels *after* releasing it, since a waiter wakes up
// and immediately wants the lock back.
func (s *Session) drainPendingLocked() []chan protocol.Result {
	waiters := make([]chan protocol.Result, 0, len(s.pending))
	for id, ch := range s.pending {
		waiters = append(waiters, ch)
		delete(s.pending, id)
	}
	return waiters
}

func fail(waiters []chan protocol.Result, message string) {
	for _, ch := range waiters {
		ch <- protocol.Result{OK: false, Message: message}
	}
}

// push sends a frame the tab did not ask for (attached / detached). Failures are
// returned but rarely actionable: the socket is about to be cleaned up by its own
// read loop either way.
func (s *Session) push(frame any) error {
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.write(ctx, payload)
}

func (s *Session) write(ctx context.Context, payload []byte) error {
	s.mu.Lock()
	conn := s.conn
	s.mu.Unlock()
	if conn == nil {
		return ErrNoTab
	}
	// Held across the write rather than around a queue: a WebSocket admits one
	// writer at a time, and frames here are small enough that serializing them
	// costs nothing worth building a queue to avoid.
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return conn.Write(ctx, websocket.MessageText, payload)
}
