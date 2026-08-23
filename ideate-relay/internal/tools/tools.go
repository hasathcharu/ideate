// Package tools registers the twelve MCP tools an agent drives the editor with.
//
// The whole point of these, and the reason the feature exists at all, is that they
// act on the document **open in a browser right now** rather than on a file on
// disk. An edit lands in CodeMirror as a real transaction, mermaid re-renders, and
// the renderer's verdict comes back in the result of the agent's own tool call — so
// a broken diagram is fixed in the same turn. An agent editing files finds out its
// diagram is broken when a human next opens it.
//
// Two rules shape everything here:
//
//   - **Nothing writes to GitHub.** There is no commit tool, and rename and delete
//     are deliberately not exposed either, because in this app those *are* commits.
//     An agent's blast radius is the uncommitted working copy: on screen, and one
//     ⌘Z away.
//   - **Failures are tool errors with a readable message, never exceptions.** A
//     missing edit anchor, a wrong path, a scene tool aimed at a markdown document
//     — every one of them is something the agent can act on, and an exception
//     reaches the model with the useful part stripped off.
package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hasathcharu/ideate/ideate-relay/internal/protocol"
	"github.com/hasathcharu/ideate/ideate-relay/internal/ratelimit"
	"github.com/hasathcharu/ideate/ideate-relay/internal/session"
)

// Deps is what the tool layer needs from the rest of the service.
type Deps struct {
	Registry *session.Registry
	// UnknownCode rations guesses. An unknown code is what a brute-force attempt
	// looks like from here, and this is the only thing between an 8-character code
	// and an attacker willing to spend a weekend.
	UnknownCode *ratelimit.Limiter
}

/* ------------------------------------------------------------------ */
/* Argument shapes                                                     */
/* ------------------------------------------------------------------ */

// codeArgs is embedded in every tool's input, and its description is doing more
// work than it looks.
//
// The pairing code is a tool *argument* rather than an `Authorization` header, and
// that was the central design choice of this transport. A header is the more
// standard remote-MCP shape and would keep the credential out of the model's
// context — but a header lives in client config, so pointing the agent at a
// different tab would mean re-running `claude mcp add` and tearing down the MCP
// connection. Switching tabs mid-session is a hard requirement, and only an
// argument gives it: the human names another code and the very next call lands on
// a different tab.
//
// The last clause of the description below is what makes that work in practice —
// an agent that has not been told the argument is the tab selector will keep using
// whichever code it saw first. Keep it. (It cannot be factored into a constant:
// struct tags must be literals.)
type codeArgs struct {
	Code string `json:"code" jsonschema:"The pairing code shown in the browser tab's Agent Link dialog (the plug icon in the toolbar), e.g. \"K7QM-4XZP\". Case and the dash are ignored. Change this when the human names a different tab's code — that is how you switch which tab you are driving, mid-session, with no reconfiguration."`
}

type connectArgs struct {
	codeArgs
	Agent *string `json:"agent,omitempty" jsonschema:"Who is attaching, e.g. \"Claude Code\". Shown to the human in the app so the connection is not anonymous."`
}

type readArgs struct {
	codeArgs
	Path *string `json:"path,omitempty" jsonschema:"Repo-relative path. Omit to read the open document."`
}

type editArgs struct {
	codeArgs
	Edits []editArg `json:"edits" jsonschema:"Applied together against the document as it is now, not against the result of earlier edits in the same call."`
}

type editArg struct {
	OldText    string `json:"oldText" jsonschema:"Exact text to replace. Must appear in the document."`
	NewText    string `json:"newText" jsonschema:"Replacement text. Empty string deletes."`
	ReplaceAll *bool  `json:"replaceAll,omitempty" jsonschema:"Replace every occurrence. Required when oldText appears more than once — otherwise ambiguity is an error rather than a guess."`
}

type writeArgs struct {
	codeArgs
	Text string `json:"text" jsonschema:"The complete new content of the document."`
}

type openArgs struct {
	codeArgs
	Path string `json:"path" jsonschema:"Repo-relative path, as listed by ideate_list_files."`
}

type createFileArgs struct {
	codeArgs
	Path    string  `json:"path" jsonschema:"Repo-relative path including the extension."`
	Content *string `json:"content,omitempty" jsonschema:"Initial content. Omit for a starter template appropriate to the kind."`
}

type sceneGetArgs struct {
	codeArgs
	Full *bool `json:"full,omitempty" jsonschema:"Also return the entire scene file. Large; rarely needed."`
}

type sceneEditArgs struct {
	codeArgs
	Ops []sceneOpArg `json:"ops" jsonschema:"Applied in order, with all adds first."`
}

// sceneOpArg is the add/update/delete union flattened into one object.
//
// The old Node server declared it as a zod union of three shapes, which a JSON
// Schema generated from a Go struct cannot express. Flattening loses the schema's
// ability to say "id is required for update"; the handler says it instead, in a
// message that names the op and the missing field. That is a worse schema and a
// better error, and the error is what the agent actually reads when it gets it
// wrong.
type sceneOpArg struct {
	Op              string     `json:"op" jsonschema:"One of \"add\", \"update\" or \"delete\"."`
	ID              *string    `json:"id,omitempty" jsonschema:"For add: your own id for this element, so arrows in the same call can bind to it and a later call can update it; generated when omitted. For update and delete: the element id, from ideate_scene_get."`
	Type            *string    `json:"type,omitempty" jsonschema:"For add: one of \"rectangle\", \"ellipse\", \"diamond\", \"text\", \"arrow\", \"line\"."`
	X               *float64   `json:"x,omitempty"`
	Y               *float64   `json:"y,omitempty"`
	Width           *float64   `json:"width,omitempty"`
	Height          *float64   `json:"height,omitempty"`
	Text            *string    `json:"text,omitempty" jsonschema:"The content of a text element, or a label centred inside a shape. On update, rewrites the element's text or its bound label."`
	StrokeColor     *string    `json:"strokeColor,omitempty" jsonschema:"CSS color, e.g. \"#1e1e1e\"."`
	BackgroundColor *string    `json:"backgroundColor,omitempty" jsonschema:"Fill color, or \"transparent\"."`
	FillStyle       *string    `json:"fillStyle,omitempty" jsonschema:"One of \"hachure\", \"cross-hatch\", \"solid\"."`
	StrokeWidth     *float64   `json:"strokeWidth,omitempty"`
	Roughness       *float64   `json:"roughness,omitempty" jsonschema:"0 = architect, 1 = artist, 2 = cartoonist."`
	Start           *string    `json:"start,omitempty" jsonschema:"For an arrow or line: the id of the element it starts at — either something already on the canvas or something created in this same call. The arrow is routed between the two shapes for you; x and y are ignored when both ends bind."`
	End             *string    `json:"end,omitempty" jsonschema:"The id of the element the arrow or line ends at."`
	Points          []pointArg `json:"points,omitempty" jsonschema:"Explicit geometry for an unbound arrow or line, relative to x/y."`
}

type pointArg struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

// Register adds every tool to the server. Descriptions are carried across from the
// Node implementation close to verbatim: they are load-bearing, because they are
// what tells an agent that `kind` decides text tools versus scene tools, and that
// ideate_status is the thing to call first.
func Register(server *mcp.Server, deps *Deps) {
	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_connect",
		Title: "Ideate: connect",
		Description: "Attach to the Ideate browser tab holding this pairing code. Required " +
			"before any tool can read or change the document — attaching to a human's open " +
			"editor is a deliberate step, not something that happens because a code exists. " +
			"Returns what you attached to (repository, branch, open file, kind), and the app " +
			"shows the human that an agent is now connected. Call ideate_status first if you " +
			"want to check what is open before committing to it.",
	}, deps.connect)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_disconnect",
		Title: "Ideate: disconnect",
		Description: "Let go of the tab. Agent Link stays switched on in the browser and the " +
			"pairing code keeps working, so a later ideate_connect needs no action from the " +
			"human. Worth calling when you are done, so the app stops telling them an agent " +
			"can edit their document.",
	}, deps.disconnect)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_status",
		Title: "Ideate: status",
		Description: "What is open in the Ideate editor right now: mode (github/local), " +
			"repository and branch, the open file path, its kind (mermaid / markdown / " +
			"excalidraw), whether it has uncommitted changes, its size, and the cursor " +
			"position. Call this first — the kind decides whether to use the text tools or " +
			"the scene tools. Works before ideate_connect, so you can report what is open " +
			"before attaching to it.",
	}, deps.status)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_list_files",
		Title: "Ideate: list files",
		Description: "Every diagram, document and canvas file in the connected repository, on " +
			"the branch currently selected. Empty in local mode (no repository).",
	}, deps.listFiles)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_read",
		Title: "Ideate: read",
		Description: "Read a document. With no path, returns the working copy of the open " +
			"document — including uncommitted edits, which is what the human is looking at. " +
			"With a path, returns that file as committed on the current branch.",
	}, deps.read)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_edit",
		Title: "Ideate: edit",
		Description: "Edit the open document by replacing exact strings. Every edit is applied " +
			"as one undo step in the live editor, so the human sees the change appear and can " +
			"take the whole batch back with one ⌘Z. The result carries the renderer's " +
			"diagnostics, so a broken diagram can be fixed in the same turn without a separate " +
			"check. Nothing is committed — this changes the working copy only. Anchors must " +
			"match the document as it is now: if any one is missing or ambiguous, nothing is " +
			"applied and the error says which.",
	}, deps.edit)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_write",
		Title: "Ideate: write",
		Description: "Replace the whole open document. Prefer ideate_edit for anything smaller " +
			"than a rewrite — a full replacement discards the human's cursor position and makes " +
			"the change unreadable in the diff. Returns the renderer's diagnostics. Not committed.",
	}, deps.write)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_open",
		Title: "Ideate: open file",
		Description: "Open a file from the connected repository in the editor, so it becomes the " +
			"document the other tools act on. Uncommitted edits to the current document are kept " +
			"(they live in the browser's local draft storage) — nothing is lost by switching.",
	}, deps.open)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_create_file",
		Title: "Ideate: create file",
		Description: "Create a new file and open it. It exists only in the browser as an " +
			"uncommitted document until the human saves it — nothing is pushed to GitHub. The " +
			"extension decides the editor: .mmd/.mermaid for a diagram, .md/.markdown for a " +
			"document, .excalidraw for a canvas.",
	}, deps.createFile)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_check",
		Title: "Ideate: check",
		Description: "Ask the renderer what it thinks of the open document, without changing it: " +
			"mermaid parse errors for a diagram, or for every ```mermaid fence in a markdown " +
			"document. ideate_edit already returns this, so reach for it only to check something " +
			"you did not just write.",
	}, deps.check)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_scene_get",
		Title: "Ideate: read canvas",
		Description: "What is on the open Excalidraw canvas: one line per element with its id, " +
			"type, position, size and text. Ids are what ideate_scene_edit addresses. The full " +
			"scene JSON is available but large and mostly bookkeeping — the summary is nearly " +
			"always what you want.",
	}, deps.sceneGet)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_scene_edit",
		Title: "Ideate: edit canvas",
		Description: "Add, move, restyle or remove elements on the open Excalidraw canvas. The " +
			"change appears on the canvas immediately and is not committed. Adds are processed " +
			"first, as one batch, so an arrow can join two shapes created in the same call, and " +
			"an update can target something the call just added.",
	}, deps.sceneEdit)
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

func (d *Deps) connect(ctx context.Context, _ *mcp.CallToolRequest, in connectArgs) (*mcp.CallToolResult, any, error) {
	s, err := d.resolve(ctx, in.Code)
	if err != nil {
		return nil, nil, err
	}
	agent := ""
	if in.Agent != nil {
		agent = *in.Agent
	}
	state, err := s.Attach(agent)
	if err != nil {
		return nil, nil, translate(err)
	}
	return jsonResult(map[string]any{"attached": true, "tab": state})
}

func (d *Deps) disconnect(ctx context.Context, _ *mcp.CallToolRequest, in codeArgs) (*mcp.CallToolResult, any, error) {
	s, err := d.resolve(ctx, in.Code)
	if err != nil {
		return nil, nil, err
	}
	s.Detach("The agent called ideate_disconnect.")
	return jsonResult(map[string]any{"attached": false})
}

// status is the one tool allowed through unattached.
//
// It returns metadata about *which* document is open and never its content, which
// is precisely what lets an agent describe what attaching would give it without
// first helping itself to it. Widening this to anything that reads the document
// would collapse the distinction that makes ideate_connect mean something.
func (d *Deps) status(ctx context.Context, _ *mcp.CallToolRequest, in codeArgs) (*mcp.CallToolResult, any, error) {
	s, err := d.resolve(ctx, in.Code)
	if err != nil {
		return nil, nil, err
	}
	if attached, _ := s.Attached(); !attached {
		if !s.HasTab() {
			return nil, nil, errors.New(
				"That pairing code has no tab connected right now. Ask the human to switch " +
					"Agent Link on in the browser tab they want you to drive, then try again.")
		}
		return jsonResult(map[string]any{
			"attached": false,
			"hint":     "A tab holds this code. Call ideate_connect to attach before reading or editing.",
			"tab":      s.State(),
		})
	}
	return d.forward(ctx, s, protocol.Command{Cmd: protocol.CmdStatus})
}

func (d *Deps) listFiles(ctx context.Context, _ *mcp.CallToolRequest, in codeArgs) (*mcp.CallToolResult, any, error) {
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdListFiles})
}

func (d *Deps) read(ctx context.Context, _ *mcp.CallToolRequest, in readArgs) (*mcp.CallToolResult, any, error) {
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdRead, Path: in.Path})
}

func (d *Deps) edit(ctx context.Context, _ *mcp.CallToolRequest, in editArgs) (*mcp.CallToolResult, any, error) {
	if len(in.Edits) == 0 {
		return nil, nil, errors.New("edits is empty — pass at least one { oldText, newText } pair.")
	}
	edits := make([]protocol.TextEdit, 0, len(in.Edits))
	for i, e := range in.Edits {
		if e.OldText == "" {
			return nil, nil, fmt.Errorf(
				"edits[%d].oldText is empty. An empty anchor matches everywhere, so it is "+
					"refused rather than applied somewhere arbitrary — use ideate_write to "+
					"replace the whole document", i)
		}
		edits = append(edits, protocol.TextEdit{
			OldText: e.OldText, NewText: e.NewText, ReplaceAll: e.ReplaceAll,
		})
	}
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdEdit, Edits: edits})
}

func (d *Deps) write(ctx context.Context, _ *mcp.CallToolRequest, in writeArgs) (*mcp.CallToolResult, any, error) {
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdWrite, Text: &in.Text})
}

func (d *Deps) open(ctx context.Context, _ *mcp.CallToolRequest, in openArgs) (*mcp.CallToolResult, any, error) {
	if in.Path == "" {
		return nil, nil, errors.New("path is empty — pass a repo-relative path, as listed by ideate_list_files.")
	}
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdOpen, Path: &in.Path})
}

func (d *Deps) createFile(ctx context.Context, _ *mcp.CallToolRequest, in createFileArgs) (*mcp.CallToolResult, any, error) {
	if in.Path == "" {
		return nil, nil, errors.New("path is empty — pass a repo-relative path including the extension.")
	}
	return d.attached(ctx, in.Code, protocol.Command{
		Cmd: protocol.CmdCreateFile, Path: &in.Path, Content: in.Content,
	})
}

func (d *Deps) check(ctx context.Context, _ *mcp.CallToolRequest, in codeArgs) (*mcp.CallToolResult, any, error) {
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdCheck})
}

func (d *Deps) sceneGet(ctx context.Context, _ *mcp.CallToolRequest, in sceneGetArgs) (*mcp.CallToolResult, any, error) {
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdSceneGet, Full: in.Full})
}

func (d *Deps) sceneEdit(ctx context.Context, _ *mcp.CallToolRequest, in sceneEditArgs) (*mcp.CallToolResult, any, error) {
	ops, err := sceneOps(in.Ops)
	if err != nil {
		return nil, nil, err
	}
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdSceneEdit, Ops: ops})
}

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

// resolve turns a pairing code into a bucket, or into a message that tells the
// agent what to ask the human for.
func (d *Deps) resolve(ctx context.Context, code string) (*session.Session, error) {
	hash := session.Hash(code)
	s := d.Registry.Lookup(hash)
	if s == nil {
		// Only *unknown* codes are rationed, and only the first sighting of each.
		// A busy agent working against a real tab must never be slowed down by the
		// control that exists to slow down somebody guessing — and neither must
		// the colleague sharing its public address, which is what charging an
		// agent's repeated stale code used to do. See AllowDistinct.
		if !d.UnknownCode.AllowDistinct(ratelimit.ClientIPFrom(ctx), hash) {
			return nil, errors.New(
				"Too many attempts with pairing codes that match no tab. Wait a moment, " +
					"and ask the human to read you the code from their Agent Link dialog " +
					"rather than trying variations.")
		}
		return nil, errors.New(
			"No browser tab is paired with that code. Ask the human for the code shown " +
				"in the Ideate tab's Agent Link dialog — the plug icon in the toolbar — " +
				"and check that Agent Link is switched on there.")
	}
	return s, nil
}

// attached resolves, insists on an attachment, and forwards.
func (d *Deps) attached(ctx context.Context, code string, cmd protocol.Command) (*mcp.CallToolResult, any, error) {
	s, err := d.resolve(ctx, code)
	if err != nil {
		return nil, nil, err
	}
	if ok, _ := s.Attached(); !ok {
		return nil, nil, errors.New(
			"Not attached to that tab. Call ideate_connect with the same code first — " +
				"reading or editing someone's open document is a deliberate step, not " +
				"something that happens because a pairing code exists.")
	}
	// Counted as activity even though the command may still fail: an agent that is
	// calling tools is an agent that has not gone away, which is the only thing the
	// idle clock is trying to find out.
	s.Touch()
	return d.forward(ctx, s, cmd)
}

func (d *Deps) forward(ctx context.Context, s *session.Session, cmd protocol.Command) (*mcp.CallToolResult, any, error) {
	data, err := s.Call(ctx, cmd)
	if err != nil {
		return nil, nil, translate(err)
	}
	// The tab's answer is already JSON. Re-indenting it rather than passing the
	// bytes through keeps the result readable in a transcript, which is where an
	// agent's own diagnostics get read back by a human.
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, data, "", "  "); err != nil {
		return textResult(string(data)), nil, nil
	}
	return textResult(pretty.String()), nil, nil
}

// translate rewrites the registry's sentinel errors into something an agent can act
// on. They are sentinels rather than strings inside the session package because the
// WebSocket handler turns the same conditions into close codes.
func translate(err error) error {
	switch {
	case errors.Is(err, session.ErrNoTab):
		return errors.New(
			"That code's tab is not connected right now. If the page is reloading it " +
				"will be back in a moment and your attachment is kept; otherwise ask the " +
				"human to switch Agent Link on in the tab they want you to drive.")
	case errors.Is(err, session.ErrNotAttached):
		return errors.New("Not attached to that tab. Call ideate_connect with the same code first.")
	case errors.Is(err, session.ErrBusy):
		return fmt.Errorf("%w — this is temporary, so the same call is worth retrying", err)
	default:
		return err
	}
}

func jsonResult(value any) (*mcp.CallToolResult, any, error) {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, nil, fmt.Errorf("could not encode the result: %w", err)
	}
	return textResult(string(encoded)), nil, nil
}

func textResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}

// sceneOps validates the flattened union and converts it to the wire shape. The
// checks below are the ones the JSON Schema cannot state; see sceneOpArg.
func sceneOps(in []sceneOpArg) ([]protocol.SceneOp, error) {
	if len(in) == 0 {
		return nil, errors.New("ops is empty — pass at least one add, update or delete.")
	}
	out := make([]protocol.SceneOp, 0, len(in))
	for i, op := range in {
		switch op.Op {
		case "add":
			if op.Type == nil || *op.Type == "" {
				return nil, fmt.Errorf(
					"ops[%d] is an add with no type. Use one of: rectangle, ellipse, "+
						"diamond, text, arrow, line", i)
			}
			if !validElementType(*op.Type) {
				return nil, fmt.Errorf(
					"ops[%d].type is %q. Use one of: rectangle, ellipse, diamond, text, "+
						"arrow, line", i, *op.Type)
			}
			// An arrow that binds both ends is routed by the app, so its own
			// coordinates are ignored; anything else has to say where it goes.
			bound := op.Start != nil && op.End != nil
			if !bound && (op.X == nil || op.Y == nil) {
				return nil, fmt.Errorf(
					"ops[%d] is an add with no x/y. Every element needs a position, except "+
						"an arrow or line that binds both start and end — those are routed "+
						"between the two shapes for you", i)
			}
		case "update", "delete":
			if op.ID == nil || *op.ID == "" {
				return nil, fmt.Errorf(
					"ops[%d] is a %s with no id. Ids come from ideate_scene_get", i, op.Op)
			}
		default:
			return nil, fmt.Errorf("ops[%d].op is %q. Use \"add\", \"update\" or \"delete\"", i, op.Op)
		}

		converted := protocol.SceneOp{
			Op: op.Op, ID: op.ID, Type: op.Type, X: op.X, Y: op.Y,
			Width: op.Width, Height: op.Height, Text: op.Text,
			StrokeColor: op.StrokeColor, BackgroundColor: op.BackgroundColor,
			FillStyle: op.FillStyle, StrokeWidth: op.StrokeWidth,
			Roughness: op.Roughness, Start: op.Start, End: op.End,
		}
		if len(op.Points) > 0 {
			converted.Points = make([]protocol.ScenePoint, len(op.Points))
			for j, p := range op.Points {
				converted.Points[j] = protocol.ScenePoint{X: p.X, Y: p.Y}
			}
		}
		out = append(out, converted)
	}
	return out, nil
}

func validElementType(t string) bool {
	switch t {
	case "rectangle", "ellipse", "diamond", "text", "arrow", "line":
		return true
	}
	return false
}
