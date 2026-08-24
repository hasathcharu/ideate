// Package tools registers the thirteen MCP tools an agent drives the editor with.
//
// The whole point of these, and the reason the feature exists at all, is that they
// act on a document **in a browser right now** rather than on a file on disk. An
// edit lands in CodeMirror as a real transaction, mermaid re-renders, and the
// renderer's verdict comes back in the result of the agent's own tool call — so a
// broken diagram is fixed in the same turn. An agent editing files finds out its
// diagram is broken when a human next opens it.
//
// From protocol 4 that document need not be the one on screen: every tool that
// names a document takes an optional path (docPathArgs), and only the *default* is
// the open one. The renderer still has the last word either way, because the tab is
// still what runs the command.
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
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hasathcharu/ideate/ideate-mcp/internal/protocol"
	"github.com/hasathcharu/ideate/ideate-mcp/internal/ratelimit"
	"github.com/hasathcharu/ideate/ideate-mcp/internal/session"
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

// docPathArgs names the document a *reading* tool acts on, and may be omitted.
//
// Before this existed the tools meant "whatever the human is looking at", so an
// agent asked to fix six diagrams had to ideate_open each one — which drags the
// human's editor to a different file six times and loses their cursor each time.
// The path makes that work invisible to them.
//
// Optional here because "what is on screen" is a real question, and reading the
// wrong document costs one wasted call. The mutating tools take targetPathArgs
// below instead, where it is not optional at all.
type docPathArgs struct {
	Path *string `json:"path,omitempty" jsonschema:"Repository-relative path, as listed by ideate_list_files. Omit it to read the open document. A path leaves the editor where it is, so prefer it to ideate_open for work across several files."`
}

// targetPathArgs names the document a *mutating* tool changes, and is required.
//
// Required because the open document is not a stable address. The human keeps
// browsing their files while the agent works, so "the open document" means whichever
// one they clicked last — and an edit that lands on the wrong file is not something
// reading it again can undo. Naming the path costs one ideate_status call and makes
// the target the agent's own decision.
//
// The field stays a pointer, and the schema stays permissive, for one case: the
// **untitled** document has no path yet, so omission is the only way to name it. That
// is a state of the tab, not a mode of the app — local mode has its own files, and a
// connected repo still has an untitled document until the human saves it somewhere.
// Only the tab knows which document is open, so the tab is where the refusal lives
// (AppShell's requirePath) — one implementation, and the one that cannot be wrong. Do
// not add a second here against the pushed state.
type targetPathArgs struct {
	Path *string `json:"path,omitempty" jsonschema:"Repository-relative path, as listed by ideate_list_files. Required: the open document changes as the human browses, so an unnamed target can be a file you never read. Call ideate_status for the open path. Omit it only when ideate_status reports no open path, which means the untitled document has no path to name yet."`
}

type readArgs struct {
	codeArgs
	docPathArgs
}

type editArgs struct {
	codeArgs
	targetPathArgs
	Edits []editArg `json:"edits" jsonschema:"Applied together against the document as it is now, not against the result of earlier edits in the same call."`
}

type editArg struct {
	OldText    string `json:"oldText" jsonschema:"Exact text to replace. Must appear in the document."`
	NewText    string `json:"newText" jsonschema:"Replacement text. Empty string deletes."`
	ReplaceAll *bool  `json:"replaceAll,omitempty" jsonschema:"Replace every occurrence. Required when oldText appears more than once — otherwise ambiguity is an error rather than a guess."`
}

type writeArgs struct {
	codeArgs
	targetPathArgs
	Text string `json:"text" jsonschema:"The complete new content of the document."`
}

type checkArgs struct {
	codeArgs
	docPathArgs
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

// createCanvasArgs is create_file's path plus scene_edit's ops.
//
// Path is required and non-pointer, like openArgs and createFileArgs: a command
// whose purpose is to make a *new* document has nothing to default to. Ops is
// optional, because "give me a blank canvas to draw on next" is a reasonable thing
// to ask for and refusing it would only push the agent into two calls.
type createCanvasArgs struct {
	codeArgs
	Path string       `json:"path" jsonschema:"Repo-relative path ending in .excalidraw. Must not already exist — use ideate_scene_edit to change a canvas that does."`
	Ops  []sceneOpArg `json:"ops,omitempty" jsonschema:"The drawing, as ideate_scene_edit ops. Applied in order with all adds first, so arrows can bind to shapes created in the same call. Omit for an empty canvas."`
}

type sceneGetArgs struct {
	codeArgs
	docPathArgs
	Full *bool `json:"full,omitempty" jsonschema:"Also return the entire scene file. Large; rarely needed."`
}

type sceneEditArgs struct {
	codeArgs
	targetPathArgs
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
	StrokeColor     *string    `json:"strokeColor,omitempty" jsonschema:"CSS color, e.g. \"#1e1e1e\". Omit unless the human asked for a specific color, or you are matching colors ideate_scene_get reported on neighbouring elements. Author light values whatever theme the app is in: dark mode is a filter over the whole canvas, so a dark color you pick is inverted to a light one on screen."`
	BackgroundColor *string    `json:"backgroundColor,omitempty" jsonschema:"Fill color, or \"transparent\". Same rule as strokeColor: omit by default, and author light values even in dark mode."`
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
			"excalidraw), whether it has uncommitted changes, its size, the cursor " +
			"position, and the active theme. Call this first — the kind decides whether to " +
			"use the text tools or the scene tools, and the theme decides how to color " +
			"things: the app applies that palette when it renders, so a diagram needs no " +
			"colors of its own. Works before ideate_connect, so you can report what is open " +
			"before attaching to it.",
	}, deps.status)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_list_files",
		Title: "Ideate: list files",
		Description: "Every file the human can open: a diagram, a document or a canvas. In " +
			"GitHub mode, the connected repository on its current branch. In local mode, the " +
			"files this browser holds. The list includes unsaved files. It is empty only when " +
			"the human picked no repository.",
	}, deps.listFiles)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_read",
		Title: "Ideate: read",
		Description: "Read a document. Omit `path` for the open document. A path reads that file " +
			"and does not open it. You always get the working copy. A file with unsaved edits " +
			"in this browser answers with those edits. The `committed` field tells you if the " +
			"text matches the saved copy.",
	}, deps.read)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_edit",
		Title: "Ideate: edit",
		Description: "Replace exact strings in a document. Name the file in `path`. An edit to " +
			"the open document makes one undo step in the live editor. An edit to another file " +
			"marks that file unsaved in the file tree, and the editor does not move. If no file " +
			"matches the path, this tool creates the file from the starter template for that " +
			"extension. To write a new file from whole content, use ideate_write. The result " +
			"carries diagnostics from the renderer, so you can fix a broken diagram in the same " +
			"turn. This tool does not commit to GitHub. Every anchor must match the document as " +
			"it is now. If one anchor fails, nothing changes and nothing is created. Write no " +
			"colors into a diagram unless the human asked for one. The theme ideate_status " +
			"reports is applied when the app renders, and the file keeps bare ```mermaid " +
			"fences — so a style or classDef line with a hex color in it survives every theme " +
			"the human picks afterwards, which is rarely what they meant.",
	}, deps.edit)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_write",
		Title: "Ideate: write",
		Description: "Replace all the content of a document. Name the file in `path`. If no " +
			"file matches the path, this tool creates the file with the text you give. For " +
			"anything smaller than a rewrite, use ideate_edit. A full replacement discards the " +
			"cursor position and hides the change in the diff. The result carries diagnostics " +
			"from the renderer. This tool does not commit to GitHub. As with ideate_edit, " +
			"leave colors out of a diagram: the theme is applied at render time, and colors " +
			"in the file outlive it.",
	}, deps.write)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_open",
		Title: "Ideate: open file",
		Description: "Open a file in the editor, so the human sees it. The other tools do not " +
			"need this: they take a path. The editor keeps unsaved edits to the current " +
			"document, so switching loses nothing.",
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
		Name:  "ideate_create_canvas",
		Title: "Ideate: create canvas",
		Description: "Draw a new Excalidraw canvas and open it, in one call. The path must " +
			"end in .excalidraw and must not exist yet. Pass the drawing as ideate_scene_edit " +
			"ops, or no ops for a blank canvas. This is the tool for a canvas the human should " +
			"see: ideate_scene_edit also creates a file its path does not match, but it " +
			"deliberately leaves the editor where it is, which for a brand new drawing means " +
			"nobody is looking at it. Like ideate_create_file, the canvas exists only in the " +
			"browser as an uncommitted document until the human saves it — nothing is pushed " +
			"to GitHub.",
	}, deps.createCanvas)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_check",
		Title: "Ideate: check",
		Description: "Report what the renderer thinks of a document. This tool changes nothing. " +
			"Omit `path` for the open document. You get mermaid parse errors for a diagram, and " +
			"one error for each ```mermaid fence in a markdown document. ideate_edit returns the " +
			"same diagnostics. Use this tool only for text you did not write yourself.",
	}, deps.check)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_scene_get",
		Title: "Ideate: read canvas",
		Description: "List the elements on an Excalidraw canvas. Omit `path` for the open " +
			"canvas. A path reads that file and does not open it. Each element gets one line " +
			"with its id, type, position, size, text and colors. ideate_scene_edit addresses " +
			"these ids, and the colors are there so an addition can match what is already " +
			"drawn. Ask for `full` to get the whole scene JSON. It is large and mostly " +
			"bookkeeping.",
	}, deps.sceneGet)

	mcp.AddTool(server, &mcp.Tool{
		Name:  "ideate_scene_edit",
		Title: "Ideate: edit canvas",
		Description: "Add, move, restyle or remove elements on an Excalidraw canvas. Name the " +
			"file in `path`. If no file matches a `.excalidraw` path, this tool creates a blank " +
			"canvas. Use ideate_create_canvas instead when you want the human to see the new " +
			"canvas. An edit to the open canvas appears at once. An edit to another file marks " +
			"that file unsaved in the file tree, and the editor does not move. This tool does " +
			"not commit to GitHub. Adds run first, as one batch, so an arrow can join two " +
			"shapes from the same call. Unlike a diagram, a canvas stores its colors: there is " +
			"no theme to apply later, so omitting them keeps the app's defaults and matching " +
			"the colors ideate_scene_get reported keeps a drawing consistent. Author light " +
			"colors even when the theme is dark — dark mode is a filter over the whole canvas, " +
			"so a dark color comes out light.",
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
	if err := checkDocPath(in.Path); err != nil {
		return nil, nil, err
	}
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdRead, Path: in.Path})
}

func (d *Deps) edit(ctx context.Context, _ *mcp.CallToolRequest, in editArgs) (*mcp.CallToolResult, any, error) {
	if err := checkDocPath(in.Path); err != nil {
		return nil, nil, err
	}
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
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdEdit, Path: in.Path, Edits: edits})
}

func (d *Deps) write(ctx context.Context, _ *mcp.CallToolRequest, in writeArgs) (*mcp.CallToolResult, any, error) {
	if err := checkDocPath(in.Path); err != nil {
		return nil, nil, err
	}
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdWrite, Path: in.Path, Text: &in.Text})
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

// createCanvas is create_file and scene_edit in one command.
//
// The ops are validated here, before the tab is asked for anything, so a malformed
// drawing does not leave a blank canvas open in the human's editor with an error in
// the agent's transcript. The tab applies the same all-or-nothing rule internally
// (sceneEdit resolves before it writes), but the cheap refusal belongs on this side.
func (d *Deps) createCanvas(ctx context.Context, _ *mcp.CallToolRequest, in createCanvasArgs) (*mcp.CallToolResult, any, error) {
	if in.Path == "" {
		return nil, nil, errors.New(
			"path is empty — pass a repo-relative path ending in .excalidraw.")
	}
	if !strings.HasSuffix(strings.ToLower(in.Path), ".excalidraw") {
		return nil, nil, fmt.Errorf(
			"%s is not a canvas: the extension decides the editor, and only .excalidraw "+
				"opens one. Use ideate_create_file for a .mmd diagram or a .md document.", in.Path)
	}
	// Empty and absent are the same thing here, unlike everywhere else in this
	// package: a canvas with no elements is a legitimate request, and "ops": [] is
	// how a model spells it about as often as omitting the field.
	var ops []protocol.SceneOp
	if len(in.Ops) > 0 {
		converted, err := sceneOps(in.Ops)
		if err != nil {
			return nil, nil, err
		}
		ops = converted
	}
	return d.attached(ctx, in.Code, protocol.Command{
		Cmd: protocol.CmdCreateCanvas, Path: &in.Path, Ops: ops,
	})
}

func (d *Deps) check(ctx context.Context, _ *mcp.CallToolRequest, in checkArgs) (*mcp.CallToolResult, any, error) {
	if err := checkDocPath(in.Path); err != nil {
		return nil, nil, err
	}
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdCheck, Path: in.Path})
}

func (d *Deps) sceneGet(ctx context.Context, _ *mcp.CallToolRequest, in sceneGetArgs) (*mcp.CallToolResult, any, error) {
	if err := checkDocPath(in.Path); err != nil {
		return nil, nil, err
	}
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdSceneGet, Path: in.Path, Full: in.Full})
}

func (d *Deps) sceneEdit(ctx context.Context, _ *mcp.CallToolRequest, in sceneEditArgs) (*mcp.CallToolResult, any, error) {
	if err := checkDocPath(in.Path); err != nil {
		return nil, nil, err
	}
	ops, err := sceneOps(in.Ops)
	if err != nil {
		return nil, nil, err
	}
	return d.attached(ctx, in.Code, protocol.Command{Cmd: protocol.CmdSceneEdit, Path: in.Path, Ops: ops})
}

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

// checkDocPath refuses a path that is present but empty.
//
// Absent and empty are different commands on this wire (see protocol.Command), and
// only one of them is a decision: a model that fills in "" for an optional string
// has not chosen the open document, it has failed to omit the field. Forwarding it
// would reach the tab as a path naming no file, which the tab would then offer to
// create.
func checkDocPath(path *string) error {
	if path != nil && *path == "" {
		return errors.New(
			"path is present but empty. Omit the field entirely to act on the open " +
				"document, or pass a repo-relative path as listed by ideate_list_files.")
	}
	return nil
}

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
