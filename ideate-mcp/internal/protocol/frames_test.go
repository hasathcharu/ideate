package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The Go half of the cross-language wire guard. See the package comment and
// testdata/frames/README.md for why it exists at all.
//
// Two distinct failures are checked, and only both together catch drift:
//
//   - Decoding with DisallowUnknownFields catches a field the fixture has and Go
//     does not — a rename, a typo, or a field simply never mirrored.
//   - Re-encoding and comparing catches the opposite: a field Go drops on the way
//     out (the `omitempty`-on-a-value-type trap), or spells differently, or emits
//     when it should not.
//
// A plain "does it decode" test would pass on all of those.

const framesDir = "../../testdata/frames"

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(framesDir, name+".json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return raw
}

// roundTrip decodes name into a fresh V, strictly, then re-encodes it and asserts
// the result means the same thing as the file. Returns the decoded value so a
// caller can additionally assert on the fields it cares about.
func roundTrip[V any](t *testing.T, name string) V {
	t.Helper()
	raw := fixture(t, name)

	var decoded V
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&decoded); err != nil {
		t.Fatalf("%s: decode into %T: %v", name, decoded, err)
	}

	encoded, err := json.Marshal(decoded)
	if err != nil {
		t.Fatalf("%s: re-encode: %v", name, err)
	}

	// Compared as parsed values rather than bytes: key order and whitespace are
	// not part of the contract, and asserting on them would make the fixtures
	// unformattable.
	var want, got any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("%s: fixture is not valid JSON: %v", name, err)
	}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("%s: re-encoded frame is not valid JSON: %v", name, err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Errorf("%s did not round-trip\n fixture: %s\n  re-encoded: %s", name, raw, encoded)
	}
	return decoded
}

func TestServerFramesRoundTrip(t *testing.T) {
	if got := roundTrip[Ready](t, "server-ready"); got.T != TReady {
		t.Errorf("tag = %q, want %q", got.T, TReady)
	}

	if got := roundTrip[Attached](t, "server-attached"); got.Agent == nil || *got.Agent != "Claude Code" {
		t.Errorf("agent = %v, want %q", got.Agent, "Claude Code")
	}
	// An agent that declined to name itself. The distinction this protects is
	// null (anonymous) versus the key being absent, which the TypeScript side
	// would read as undefined.
	if got := roundTrip[Attached](t, "server-attached-anonymous"); got.Agent != nil {
		t.Errorf("agent = %v, want nil", got.Agent)
	}

	roundTrip[Detached](t, "server-detached")

	for _, name := range []string{
		"server-req-status",
		"server-req-list-files",
		"server-req-read-path",
		"server-req-edit",
		"server-req-write",
		"server-req-open",
		"server-req-create-file",
		"server-req-create-canvas",
		"server-req-create-canvas-blank",
		"server-req-check",
		"server-req-scene-edit",
		"server-req-scene-edit-layout",
		"server-req-scene-render",
	} {
		roundTrip[Request](t, name)
	}

	// The layout ops, and `gap` in particular: it is the field this file's whole
	// method exists for. A bare float64 with omitempty drops a gap of 0, and the tab
	// then equalizes the spacing of a row somebody asked to have butted together.
	if got := roundTrip[Request](t, "server-req-scene-edit-layout"); len(got.Command.Ops) != 3 {
		t.Errorf("layout ops = %d, want 3", len(got.Command.Ops))
	} else {
		if len(got.Command.Ops[0].IDs) != 3 {
			t.Errorf("align ids = %d, want 3", len(got.Command.Ops[0].IDs))
		}
		if got.Command.Ops[1].Gap != nil {
			t.Errorf("distribute with no gap decoded one: %v", *got.Command.Ops[1].Gap)
		}
		if got.Command.Ops[2].Gap == nil || *got.Command.Ops[2].Gap != 0 {
			t.Errorf("distribute gap = %v, want a present 0", got.Command.Ops[2].Gap)
		}
	}

	// create_canvas with no ops is the one command where an absent slice is a
	// meaningful request rather than an omission — "open me a blank canvas" — so it
	// gets the same paired treatment as the optional paths below.
	if got := roundTrip[Request](t, "server-req-create-canvas-blank"); got.Command.Ops != nil {
		t.Errorf("blank create_canvas decoded %d ops", len(got.Command.Ops))
	}
	if got := roundTrip[Request](t, "server-req-create-canvas"); len(got.Command.Ops) != 3 {
		t.Errorf("create_canvas ops = %d, want 3", len(got.Command.Ops))
	}

	// The shapes whose whole point is an absent or falsy optional field. A bare
	// string/bool with omitempty passes every other test in this file and fails
	// these.
	for _, name := range []string{
		"server-req-edit",
		"server-req-write",
		"server-req-check",
		"server-req-scene-edit",
		"server-req-scene-render",
		"server-req-read-open",
	} {
		if got := roundTrip[Request](t, name); got.Command.Path != nil {
			t.Errorf("%s has no path but decoded one: %q", name, *got.Command.Path)
		}
	}
	if got := roundTrip[Request](t, "server-req-scene-get"); got.Command.Full == nil || *got.Command.Full {
		t.Errorf("scene_get full = %v, want a present false", got.Command.Full)
	}

	// And the same commands carrying one. Protocol 4 made the path optional on all
	// of them, so each has a pair of fixtures — a dropped path here would not fail
	// loudly, it would quietly act on whatever the human has open.
	for name, want := range map[string]string{
		"server-req-edit-path":         "docs/architecture.md",
		"server-req-write-path":        "diagrams/new.mmd",
		"server-req-check-path":        "docs/architecture.md",
		"server-req-scene-get-path":    "canvas/sketch.excalidraw",
		"server-req-scene-edit-path":   "canvas/sketch.excalidraw",
		"server-req-scene-render-path": "canvas/sketch.excalidraw",
	} {
		got := roundTrip[Request](t, name)
		if got.Command.Path == nil {
			t.Errorf("%s lost its path", name)
			continue
		}
		if *got.Command.Path != want {
			t.Errorf("%s path = %q, want %q", name, *got.Command.Path, want)
		}
	}
}

func TestClientFramesRoundTrip(t *testing.T) {
	hello := roundTrip[Hello](t, "client-hello")
	// The fixture carries the version this build is compiled against; a bump on
	// one side of the wire only is exactly the drift these files exist to catch.
	if hello.Protocol != Version {
		t.Errorf("fixture protocol = %d, but this build speaks %d", hello.Protocol, Version)
	}

	if got := roundTrip[Result](t, "client-res-ok"); !got.OK || len(got.Data) == 0 {
		t.Errorf("ok result decoded as ok=%v data=%q", got.OK, got.Data)
	}
	if got := roundTrip[Result](t, "client-res-error"); got.OK || got.Message == "" {
		t.Errorf("error result decoded as ok=%v message=%q", got.OK, got.Message)
	}

	event := roundTrip[StateEvent](t, "client-event-state")
	if event.State.Repo == nil || event.State.Repo.Branch != "v3" {
		t.Errorf("state repo = %+v, want branch v3", event.State.Repo)
	}
	// The theme is the field an agent reads to decide whether to write colors at
	// all, so a name silently dropped on the way through is a diagram with hex
	// codes baked into it.
	if event.State.Theme.Name == nil || *event.State.Theme.Name != "tokyo-night" {
		t.Errorf("state theme name = %v, want tokyo-night", event.State.Theme.Name)
	}
	if event.State.Theme.Mode != "dark" {
		t.Errorf("state theme mode = %q, want dark", event.State.Theme.Mode)
	}
}

// Tag has to work on every frame the read loop can see, since it is what picks
// the concrete type before anything is decoded into one.
func TestTag(t *testing.T) {
	for name, want := range map[string]string{
		"client-hello":       THello,
		"client-res-ok":      TRes,
		"client-event-state": TEvent,
		"server-ready":       TReady,
		"server-req-status":  TReq,
	} {
		if got := Tag(fixture(t, name)); got != want {
			t.Errorf("Tag(%s) = %q, want %q", name, got, want)
		}
	}
	for _, junk := range []string{"", "not json", "[1,2,3]", `"a string"`, `{"t":7}`} {
		if got := Tag([]byte(junk)); got != "" {
			t.Errorf("Tag(%q) = %q, want empty", junk, got)
		}
	}
}

// The builders are the only way frames are constructed outside tests, so their
// output is what actually goes on the wire — asserting they match the fixtures
// closes the loop that the decode tests above open.
func TestBuildersMatchFixtures(t *testing.T) {
	agent := "Claude Code"
	path := "docs/architecture.md"
	cases := []struct {
		name  string
		frame any
	}{
		{"server-ready", NewReady()},
		{"server-attached", NewAttached(agent)},
		{"server-attached-anonymous", NewAttached("")},
		{"server-detached", NewDetached()},
		{"server-req-read-path", NewRequest(4, Command{Cmd: CmdRead, Path: &path})},
		{"server-req-status", NewRequest(1, Command{Cmd: CmdStatus})},
	}
	for _, tc := range cases {
		encoded, err := json.Marshal(tc.frame)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		var want, got any
		_ = json.Unmarshal(fixture(t, tc.name), &want)
		_ = json.Unmarshal(encoded, &got)
		if !reflect.DeepEqual(want, got) {
			t.Errorf("%s: builder produced %s", tc.name, encoded)
		}
	}
}
