// Package protocol is the Go half of the Agent Link wire contract.
package protocol

import (
	"encoding/json"
	"time"
)

// Version is bumped on any breaking change to the frames here, and must equal PROTOCOL_VERSION in
// app/lib/agentProtocol.ts.
const Version = 7

const (
	MaxManifestFiles         = 500
	MaxSearchBytes           = 2 << 20
	MaxSearchResults         = 200
	MaxSearchContext         = 5
	MaxSearchGlobs           = 32
	MaxSearchResponseBytes   = 2 << 20
	MaxReadManyPaths         = 32
	MaxReadManyBytes         = 1 << 20
	MaxReadManyResponseBytes = 3 << 20
	MaxPatchPaths            = 32
	MaxPatchBytes            = 1 << 20
	MaxPatchResponseBytes    = 2 << 20
)

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

// MaxFrameBytes bounds one WebSocket frame in either direction.
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

type ReadManyFile struct {
	Path      string `json:"path"`
	StartLine *int   `json:"startLine,omitempty"`
	EndLine   *int   `json:"endLine,omitempty"`
}

type RevisionExpectation struct {
	Path     string `json:"path"`
	Revision any    `json:"revision"`
}

// ScenePoint is an Excalidraw arrow/line vertex, relative to the element origin.
type ScenePoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// SceneOp is the add/update/delete/align/distribute union flattened into one struct.
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

// Command names of the sixteen commands a tab can be asked to run.
const (
	CmdStatus       = "status"
	CmdListFiles    = "list_files"
	CmdManifest     = "manifest"
	CmdSearch       = "search"
	CmdReadMany     = "read_many"
	CmdApplyPatch   = "apply_patch"
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
	IDs              []string              `json:"ids,omitempty"`
	Query            *string               `json:"query,omitempty"`
	Globs            []string              `json:"globs,omitempty"`
	CaseSensitive    *bool                 `json:"caseSensitive,omitempty"`
	ContextLines     *int                  `json:"contextLines,omitempty"`
	Limit            *int                  `json:"limit,omitempty"`
	Files            []ReadManyFile        `json:"files,omitempty"`
	Workspace        *string               `json:"workspace,omitempty"`
	Patch            *string               `json:"patch,omitempty"`
	Expected         []RevisionExpectation `json:"expected,omitempty"`
	ExpectedRevision any                   `json:"expectedRevision,omitempty"`
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
type StateTheme struct {
	Name *string `json:"name"`
	Mode string  `json:"mode"`
}

// BridgeState is pushed by the tab whenever the answer changes, so ideate_status can answer without
// a round trip and a text tool aimed at a scene can be refused before one is spent.
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
	Metrics CommandMetrics  `json:"metrics"`
}

type CommandMetrics struct {
	BrowserMS int64 `json:"browserMs"`
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
