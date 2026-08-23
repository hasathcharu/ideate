package procstat

import (
	"testing"
	"time"
)

// The rate is the only arithmetic here, and it is the part that can be wrong in
// ways nobody notices: a percentage is plausible whatever it says. So it is driven
// by a counter and a clock that move exactly as much as the test says.

type fakeCPU struct {
	seconds float64
	ok      bool
}

func (f *fakeCPU) read() (float64, bool) { return f.seconds, f.ok }

type fakeClock struct{ now time.Time }

func (c *fakeClock) Now() time.Time { return c.now }

func newFakes() (*fakeClock, *fakeCPU) {
	return &fakeClock{now: time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)}, &fakeCPU{ok: true}
}

func TestCPUPercentIsPerCoreOverTheWindow(t *testing.T) {
	clock, cpu := newFakes()
	s := newSampler(clock.Now, cpu.read)

	// One sample is a reading, not a rate. Reporting 0% here would claim the
	// process is idle when the truth is that nothing has been measured yet.
	if got := s.Snapshot(); got.CPUPercent != nil {
		t.Fatalf("percent before any window = %v, want nil", *got.CPUPercent)
	}

	// Half a CPU-second over ten wall-clock seconds is 5% of one core.
	clock.now = clock.now.Add(10 * time.Second)
	cpu.seconds = 0.5
	s.Sample()
	assertPercent(t, s, 5)

	// Two whole CPU-seconds in one second is 200% — over 100 by design, because the
	// figure is per core and a service can be busy on several at once.
	clock.now = clock.now.Add(time.Second)
	cpu.seconds += 2
	s.Sample()
	assertPercent(t, s, 200)

	// Idle keeps the previous window from lingering: the number has to fall to zero
	// rather than staying at whatever the last busy window said.
	clock.now = clock.now.Add(10 * time.Second)
	s.Sample()
	assertPercent(t, s, 0)
}

// Two ways the window can be degenerate, and the arithmetic that would otherwise
// answer them with a division by zero or a negative percentage.
func TestCPUPercentSurvivesADegenerateWindow(t *testing.T) {
	clock, cpu := newFakes()
	s := newSampler(clock.Now, cpu.read)

	// A sample taken at the same instant as the last one: no elapsed time to divide
	// by, so there is still no rate rather than a ±Inf one.
	cpu.seconds = 1
	s.Sample()
	if got := s.Snapshot(); got.CPUPercent != nil {
		t.Fatalf("percent over a zero-length window = %v, want nil", *got.CPUPercent)
	}

	// A counter that goes backwards (a clock stepped, a platform quirk) clamps at
	// zero. A negative CPU percentage is never a true statement about a process.
	clock.now = clock.now.Add(time.Second)
	cpu.seconds = 0
	s.Sample()
	assertPercent(t, s, 0)
}

// Where getrusage is unavailable the CPU fields are absent, not zero — a zero would
// read as a genuine measurement of an idle process.
func TestCPUFieldsAbsentWithoutAnOSSource(t *testing.T) {
	clock, cpu := newFakes()
	cpu.ok = false
	s := newSampler(clock.Now, cpu.read)

	clock.now = clock.now.Add(10 * time.Second)
	s.Sample()

	got := s.Snapshot()
	if got.CPUSeconds != nil || got.CPUPercent != nil {
		t.Fatalf("cpu fields = %v/%v, want both nil", got.CPUSeconds, got.CPUPercent)
	}
	// The memory half must still answer: the two sources are independent.
	if got.RuntimeBytes == 0 {
		t.Error("runtimeBytes = 0 with no CPU source, want the runtime's own figure")
	}
}

// The always-available fields, and the platform ones where the platform has them.
func TestSnapshotReportsMemoryAndUptime(t *testing.T) {
	clock, cpu := newFakes()
	s := newSampler(clock.Now, cpu.read)
	clock.now = clock.now.Add(90 * time.Second)

	got := s.Snapshot()
	if got.UptimeSeconds != 90 {
		t.Errorf("uptime = %v, want 90", got.UptimeSeconds)
	}
	if got.RuntimeBytes == 0 || got.HeapBytes == 0 {
		t.Errorf("memory = runtime %d / heap %d, want both non-zero", got.RuntimeBytes, got.HeapBytes)
	}
	if got.HeapBytes > got.RuntimeBytes {
		t.Errorf("heap %d > runtime total %d, which cannot be", got.HeapBytes, got.RuntimeBytes)
	}
	if got.CPUs < 1 || got.Goroutines < 1 {
		t.Errorf("cpus = %d, goroutines = %d, want at least one of each", got.CPUs, got.Goroutines)
	}
	// Whatever this platform can answer, the real reader must agree with the
	// snapshot about *whether* it can — an omitted field on a platform that has the
	// number is a silently missing metric.
	if _, ok := cpuSeconds(); ok {
		if real := NewSampler(clock.Now).Snapshot(); real.CPUSeconds == nil {
			t.Error("cpuSeconds omitted on a platform whose getrusage works")
		}
	}
	if rss, ok := residentBytes(); ok && rss == 0 {
		t.Error("residentBytes reported ok with a zero RSS")
	}
}

func assertPercent(t *testing.T, s *Sampler, want float64) {
	t.Helper()
	got := s.Snapshot()
	if got.CPUPercent == nil {
		t.Fatalf("percent = nil, want %v", want)
	}
	if *got.CPUPercent != want {
		t.Fatalf("percent = %v, want %v", *got.CPUPercent, want)
	}
}

// The Linux memory path, exercised off Linux. A statm line is seven page counts;
// the trap is that they are pages and not bytes, so a reading that forgets the
// multiply is out by a factor of 4096 and still looks like a memory figure.
func TestParseStatm(t *testing.T) {
	// A real line from /proc/self/statm: total, resident, shared, text, lib, data, dt.
	const real = "3162 1105 785 1 0 449 0\n"
	if got, ok := parseStatm([]byte(real), 4096); !ok || got != 1105*4096 {
		t.Errorf("parseStatm(real) = %d, %v, want %d, true", got, ok, 1105*4096)
	}
	// 16KB pages are the default on arm64 macOS and exist on Linux too, so the page
	// size has to come from the machine rather than being assumed.
	if got, ok := parseStatm([]byte(real), 16384); !ok || got != 1105*16384 {
		t.Errorf("parseStatm(16k pages) = %d, %v, want %d, true", got, ok, 1105*16384)
	}

	for name, in := range map[string]string{
		"empty":        "",
		"one field":    "3162",
		"not a number": "3162 many 785 1 0 449 0",
		"negative":     "3162 -1 785 1 0 449 0",
	} {
		if got, ok := parseStatm([]byte(in), 4096); ok {
			t.Errorf("parseStatm(%s) = %d, true; want no answer", name, got)
		}
	}

	// A page size the platform could not have reported. Zero pages × zero bytes is
	// arithmetically fine and completely wrong, so it is refused instead.
	if _, ok := parseStatm([]byte(real), 0); ok {
		t.Error("parseStatm with a zero page size reported ok")
	}
}
