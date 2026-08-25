// Package protocol is the Go half of the Agent Link wire contract.
//
// The other half is app/lib/agentProtocol.ts, and the two are mirrored **by
// hand**. Before protocol 3 they were the same file — one TypeScript module that
// compiled under both the browser's tsconfig and the Node MCP server's, so the
// compiler guaranteed they agreed. Replacing that server with this one gave that
// guarantee up, and the replacement is ideate-mcp/testdata/frames: every frame
// below has a golden JSON fixture, frames_test.go decodes each one with unknown
// fields disallowed and re-encodes it, and the app's own test asserts the same
// files against typed TypeScript literals. Add a frame, add its fixture in the
// same change — see that directory's README for why "afterwards" does not work.
//
// The shape of the types here follows from round-tripping rather than from taste.
// Optional fields are pointers, never bare values with `omitempty`: `scene_get`
// with full:false and `read` with no path are different commands from `scene_get`
// with the field absent and `read` with an empty path, and a bare bool or string
// collapses each pair into one.
package protocol

import (
	"encoding/json"
	"time"
)

// Version is bumped on any breaking change to the frames here, and must equal
// PROTOCOL_VERSION in app/lib/agentProtocol.ts. The tab sends it in its hello and
// a mismatch is refused with a message naming both numbers — the alternative, a
// subtly wrong field, surfaces as an inexplicable tool failure much later.
//
// 4 made Path optional on every document command rather than only on read, so an
// agent can work on files the human does not have open. The struct below did not
// have to change for it — which is precisely why the version had to: nothing about
// these types distinguishes a service that will forward a path on an edit from one
// that will silently drop it, and dropping it edits the wrong document.
//
// 5 told the agent about the theme (BridgeState.Theme, and the colors the scene
// summary now carries) and added create_canvas. Additive in shape, bumped for the
// same reason 4 was: a tab that answers status without a theme is indistinguishable
// from one whose human set no theme, and an agent that reads no theme hardcodes
// colors into a document the app was going to theme at render time. An older tab
// would also refuse create_canvas as an unknown command, which reads as a broken
// tool rather than as two ends of different vintages.
//
// 6 added scene_render (with its optional ids, which crop it), and the align and
// distribute scene ops. The command is the
// same story as create_canvas. The ops are worse, and are the reason this could not
// be additive: an unknown *command* is refused, but an unknown op arrives inside a
// well-formed scene_edit that an older tab answers with a successful-looking result
// having moved nothing at all. Nothing in these structs can catch that; the version
// is the only thing that can.
const Version = 6

// Close codes, in the WebSocket private-use range (4000–4999), so they cannot
// collide with the protocol's own and the tab can tell a refusal from the service
// going away — which is what decides whether reconnecting is pointless, expected,
// or worth doing only when a human asks.
const (
	// CloseBadHello covers a missing, malformed, or late hello frame.
	CloseBadHello = 4001
	// CloseProtocolMismatch is the one refusal retrying cannot fix.
	CloseProtocolMismatch = 4002
	// CloseSlotTaken means another tab already holds this code's bucket.
	CloseSlotTaken     = 4003
	CloseFrameTooLarge = 4004
	// CloseServiceFull is delivered on an *accepted* socket, because a refused
	// handshake reaches a browser as an anonymous 1006 with no reason — the tab
	// could not otherwise tell "at capacity" from "the service is down". The
	// readable 529 lives on /v1/capacity, where a non-browser client can see it.
	CloseServiceFull = 4005
)

// Paths the tab and the probes live on, mirrored from TAB_PATH and CAPACITY_PATH
// in app/lib/agentProtocol.ts.
const (
	TabPath      = "/v1/tab"
	CapacityPath = "/v1/capacity"
)

// MaxFrameBytes bounds one WebSocket frame in either direction. A scene JSON is
// the largest legitimate payload and is nowhere near this.
//
// Enforced by reading with a limit one byte higher and checking the length here,
// rather than by the socket's own read limit: exceeding that limit closes with the
// protocol's generic 1009, and CloseFrameTooLarge says which side's rule was hit.
const MaxFrameBytes = 8 << 20

// HelloDeadline is how long a socket may stay un-paired. The tab is accepted and
// then closed if no valid hello arrives — a browser WebSocket cannot set request
// headers, so the pairing code has to travel in-band as the first frame.
const HelloDeadline = 2 * time.Second

/* ------------------------------------------------------------------ */
/* Commands (service → tab)                                            */
/* ------------------------------------------------------------------ */

// TextEdit is one anchored replacement. String-anchored rather than offset-based
// on purpose: an agent reasons about the text it just read, and an offset computed
// against a document the human has since edited corrupts the file silently,
// whereas a stale OldText fails loudly.
type TextEdit struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
	// ReplaceAll replaces every occurrence. Without it, OldText matching more than
	// once is an error rather than a coin flip over which one was meant.
	ReplaceAll *bool `json:"replaceAll,omitempty"`
}

// ScenePoint is an Excalidraw arrow/line vertex, relative to the element origin.
type ScenePoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// SceneOp is the add/update/delete/align/distribute union flattened into one struct.
//
// The service never interprets a scene op — it validates the shape the agent sent
// and forwards it — so splitting this into three types would buy nothing and cost
// a discriminated decode. Op carries the discriminant; everything else is optional
// because it belongs to only some of the three.
type SceneOp struct {
	Op   string  `json:"op"`
	ID   *string `json:"id,omitempty"`
	Type *string `json:"type,omitempty"`
	// Pointers rather than bare float64: 0 is a perfectly ordinary coordinate, so
	// `omitempty` on a value type would drop an element placed at the origin.
	X               *float64     `json:"x,omitempty"`
	Y               *float64     `json:"y,omitempty"`
	Width           *float64     `json:"width,omitempty"`
	Height          *float64     `json:"height,omitempty"`
	Text            *string      `json:"text,omitempty"`
	StrokeColor     *string      `json:"strokeColor,omitempty"`
	BackgroundColor *string      `json:"backgroundColor,omitempty"`
	FillStyle       *string      `json:"fillStyle,omitempty"`
	StrokeWidth     *float64     `json:"strokeWidth,omitempty"`
	Roughness       *float64     `json:"roughness,omitempty"`
	Start           *string      `json:"start,omitempty"`
	End             *string      `json:"end,omitempty"`
	Points          []ScenePoint `json:"points,omitempty"`
	// IDs, Axis and Gap belong to the layout ops. Gap is a pointer for the usual
	// reason and then some: absent means "equalize what is there", which is a
	// different request from any number, 0 included.
	IDs  []string `json:"ids,omitempty"`
	Axis *string  `json:"axis,omitempty"`
	Gap  *float64 `json:"gap,omitempty"`
}

// Command names of the twelve commands a tab can be asked to run.
const (
	CmdStatus       = "status"
	CmdListFiles    = "list_files"
	CmdRead         = "read"
	CmdEdit         = "edit"
	CmdWrite        = "write"
	CmdOpen         = "open"
	CmdCreateFile   = "create_file"
	CmdCreateCanvas = "create_canvas"
	CmdCheck        = "check"
	CmdSceneGet     = "scene_get"
	CmdSceneEdit    = "scene_edit"
	CmdSceneRender  = "scene_render"
)

// Command is the union of everything the tab can be asked to do, again flattened.
// Cmd is the discriminant; every other field belongs to a subset of the commands.
type Command struct {
	Cmd string `json:"cmd"`
	// Path is required for open, create_file and create_canvas, and optional for
	// read, edit, write, check, scene_get, scene_edit and scene_render — where
	// absent means "the document the human has open". Absent and empty are therefore different
	// commands, and the pointer is what keeps them apart; see the package comment.
	Path    *string    `json:"path,omitempty"`
	Edits   []TextEdit `json:"edits,omitempty"`
	Text    *string    `json:"text,omitempty"`
	Content *string    `json:"content,omitempty"`
	Full    *bool      `json:"full,omitempty"`
	Ops     []SceneOp  `json:"ops,omitempty"`
	// IDs belongs to scene_render, where absent means the whole canvas.
	IDs []string `json:"ids,omitempty"`
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

// StateRepo is the connected repository, or absent in local mode.
type StateRepo struct {
	Owner         string `json:"owner"`
	Name          string `json:"name"`
	Branch        string `json:"branch"`
	DefaultBranch string `json:"defaultBranch"`
}

// StateTheme is the palette the app renders with, which is not in the document.
//
// A mermaid theme is injected at render time and the file holds bare fences, so an
// agent that writes colors into a diagram opts it out of every theme the human
// picks. Mode is also what tells an agent to leave scene colors light: Excalidraw
// renders dark mode as a filter over the whole canvas. Name is nullable but never
// omitted, for the same reason as Repo below.
type StateTheme struct {
	Name *string `json:"name"`
	Mode string  `json:"mode"`
}

// BridgeState is pushed by the tab whenever the answer changes, so ideate_status
// can answer without a round trip and a text tool aimed at a scene can be refused
// before one is spent.
//
// Repo and OpenPath are nullable but never omitted: the TypeScript declares them
// `| null` and required, so an absent key would arrive there as undefined.
type BridgeState struct {
	Mode      string     `json:"mode"`
	Repo      *StateRepo `json:"repo"`
	OpenPath  *string    `json:"openPath"`
	Kind      string     `json:"kind"`
	Dirty     bool       `json:"dirty"`
	LineCount int        `json:"lineCount"`
	CharCount int        `json:"charCount"`
	Theme     StateTheme `json:"theme"`
}

/* ------------------------------------------------------------------ */
/* Frames                                                              */
/* ------------------------------------------------------------------ */

// Frame tags.
const (
	TReady    = "ready"
	TAttached = "attached"
	TDetached = "detached"
	TReq      = "req"
	THello    = "hello"
	TRes      = "res"
	TEvent    = "event"
)

// Ready tells the tab its hello was accepted and it now holds the bucket for its
// code. Deliberately not "an agent can edit this" — that is Attached.
type Ready struct {
	T string `json:"t"`
}

// NewReady builds the ready frame.
func NewReady() Ready { return Ready{T: TReady} }

// Attached says an agent deliberately claimed this tab with ideate_connect.
//
// Agent is a *string and NOT omitempty: an agent that declined to name itself
// sends null, and "anonymous" has to stay distinguishable from a frame that
// forgot the field.
type Attached struct {
	T     string  `json:"t"`
	Agent *string `json:"agent"`
}

// NewAttached builds the attached frame. An empty name becomes null rather than
// an empty string, so the tab's "an agent is attached" fallback text is reached.
func NewAttached(agent string) Attached {
	if agent == "" {
		return Attached{T: TAttached}
	}
	return Attached{T: TAttached, Agent: &agent}
}

// Detached says the agent let go — ideate_disconnect, or its attachment idled
// out. The socket stays up and the tab keeps its bucket.
type Detached struct {
	T string `json:"t"`
}

// NewDetached builds the detached frame.
func NewDetached() Detached { return Detached{T: TDetached} }

// Request carries one command to the tab. ID is echoed in the matching Result.
type Request struct {
	T       string  `json:"t"`
	ID      int64   `json:"id"`
	Command Command `json:"command"`
}

// NewRequest builds a req frame.
func NewRequest(id int64, command Command) Request {
	return Request{T: TReq, ID: id, Command: command}
}

// Hello is the tab's first frame, due within HelloDeadline. The pairing code is
// the credential and travels in-band because a browser WebSocket cannot set
// request headers.
type Hello struct {
	T        string `json:"t"`
	Code     string `json:"code"`
	Protocol int    `json:"protocol"`
}

// Result is the tab's answer to one Request. Data is set when OK, Message when
// not; both are omitempty so each shape round-trips without the other's key.
type Result struct {
	T       string          `json:"t"`
	ID      int64           `json:"id"`
	OK      bool            `json:"ok"`
	Data    json.RawMessage `json:"data,omitempty"`
	Message string          `json:"message,omitempty"`
}

// StateEvent is the tab pushing its current BridgeState.
type StateEvent struct {
	T     string      `json:"t"`
	Name  string      `json:"name"`
	State BridgeState `json:"state"`
}

// Tag reads just the frame tag, so a decoder can pick the right concrete type
// before committing to one. Returns "" for anything that is not a JSON object
// with a string t.
func Tag(raw []byte) string {
	var probe struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return ""
	}
	return probe.T
}
