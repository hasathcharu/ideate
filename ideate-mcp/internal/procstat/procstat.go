// Package procstat reports what this process is costing the box it runs on, for
// the operator's stats endpoint.
//
// It is deliberately built out of the standard library and nothing else: the
// service ships as a distroless image with no shell and no libc, so anything that
// wanted to run `ps` or link against a system library is not an option, and a
// dependency that reads /proc for us would be a lot of code for two numbers.
//
// **Do not take the CPU number from runtime/metrics.** The obvious-looking
// `/cpu/classes/total:cpu-seconds` counts *idle* GOMAXPROCS time as well as work,
// so on a multi-core box it grows at roughly GOMAXPROCS × wall-clock whatever the
// process is doing — measured here, it read 3.6 CPU-seconds for 300ms of real work.
// That is a scheduler accounting figure, not what `top` would show you, and
// publishing it as "CPU usage" would have an idle service look pegged. Getrusage is
// the actual OS accounting, and it is what this uses (see cpu_unix.go).
//
// Memory is reported twice on Linux for a reason the two numbers make obvious: RSS
// is what the platform's memory limit kills the process over, and the runtime's own
// total is what MAX_INFLIGHT_BYTES was sized against. They differ — the runtime
// counts pages it has mapped but already released back to the OS — and an operator
// staring at an OOM needs the first while anyone tuning the frame budget needs the
// second.
package procstat

import (
	"runtime"
	"runtime/metrics"
	"sync"
	"time"
)

// Snapshot is a point-in-time reading. Every field is omitted rather than zeroed
// when the platform cannot answer it: a zero would read as "this process uses no
// CPU", which is a worse answer than saying nothing.
type Snapshot struct {
	// UptimeSeconds is measured from the sampler's construction, which is startup.
	UptimeSeconds float64 `json:"uptimeSeconds"`
	// CPUs is GOMAXPROCS, not the host's core count — it is the number CPUPercent
	// can be divided by to get "percent of the CPU this process may use", and on a
	// container with a CPU limit Go sets it from that limit.
	CPUs int `json:"cpus"`
	// CPUSeconds is cumulative user+system CPU time. Nil where the platform has no
	// getrusage.
	CPUSeconds *float64 `json:"cpuSeconds,omitempty"`
	// CPUPercent is percent of *one* CPU over the last sampling window, the way top
	// reports it — so it can legitimately exceed 100 on a multi-core box. Nil until
	// two samples exist, and nil where CPUSeconds is.
	CPUPercent *float64 `json:"cpuPercent,omitempty"`
	// RSSBytes is resident set size, read from /proc. Nil off Linux.
	RSSBytes *uint64 `json:"rssBytes,omitempty"`
	// RuntimeBytes is every byte the Go runtime has mapped read-write: heap,
	// stacks, and its own metadata. Always available, and the portable stand-in for
	// RSS where RSSBytes is nil.
	RuntimeBytes uint64 `json:"runtimeBytes"`
	// HeapBytes is live heap objects — what the frame budget is spent on.
	HeapBytes  uint64 `json:"heapBytes"`
	Goroutines int    `json:"goroutines"`
}

// Sampler holds the previous CPU reading so a rate can be derived from two
// cumulative ones.
//
// The window is advanced by Sample from the service's existing sweep ticker rather
// than by a request, on purpose: computing the rate between consecutive *polls*
// would let two pollers shorten each other's window and report each other's
// numbers, and a single poller would see whatever interval its cron happened to
// use. A fixed tick means the percentage always means the same thing.
type Sampler struct {
	now func() time.Time
	// cpu is the reading function, a field only so the rate arithmetic can be
	// tested against a counter that moves on demand — a test that had to burn real
	// CPU to make the numerator move would be a slow test asserting an inequality.
	cpu   func() (float64, bool)
	start time.Time

	mu       sync.Mutex
	lastAt   time.Time
	lastCPU  float64
	percent  float64
	hasRate  bool
	hasClock bool // whether lastAt/lastCPU hold a reading to measure against
}

// NewSampler starts the clock. now may be nil, which means time.Now — it is a
// parameter so the rate is testable without sleeping.
func NewSampler(now func() time.Time) *Sampler {
	return newSampler(now, cpuSeconds)
}

func newSampler(now func() time.Time, cpu func() (float64, bool)) *Sampler {
	if now == nil {
		now = time.Now
	}
	s := &Sampler{now: now, cpu: cpu, start: now()}
	if used, ok := cpu(); ok {
		s.lastAt, s.lastCPU, s.hasClock = s.start, used, true
	}
	return s
}

// Sample closes the current window and opens the next. Called from the sweep
// ticker.
func (s *Sampler) Sample() {
	cpu, ok := s.cpu()
	if !ok {
		return
	}
	at := s.now()

	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.hasClock {
		s.lastAt, s.lastCPU, s.hasClock = at, cpu, true
		return
	}
	elapsed := at.Sub(s.lastAt).Seconds()
	// A window of zero (or a clock that went backwards) yields no rate rather than
	// a division by zero or a negative percentage.
	if elapsed > 0 {
		used := cpu - s.lastCPU
		if used < 0 {
			used = 0
		}
		s.percent, s.hasRate = used/elapsed*100, true
	}
	s.lastAt, s.lastCPU = at, cpu
}

// Snapshot reads the current numbers. Cheap: two syscalls and a runtime/metrics
// read, no stop-the-world.
func (s *Sampler) Snapshot() Snapshot {
	out := Snapshot{
		UptimeSeconds: s.now().Sub(s.start).Seconds(),
		CPUs:          runtime.GOMAXPROCS(0),
		Goroutines:    runtime.NumGoroutine(),
	}

	if cpu, ok := s.cpu(); ok {
		out.CPUSeconds = &cpu
	}
	if rss, ok := residentBytes(); ok {
		out.RSSBytes = &rss
	}

	// runtime/metrics rather than ReadMemStats: the same numbers without the
	// stop-the-world, and /v1/stats is a route an operator may well poll.
	samples := []metrics.Sample{
		{Name: "/memory/classes/total:bytes"},
		{Name: "/memory/classes/heap/objects:bytes"},
	}
	metrics.Read(samples)
	if samples[0].Value.Kind() == metrics.KindUint64 {
		out.RuntimeBytes = samples[0].Value.Uint64()
	}
	if samples[1].Value.Kind() == metrics.KindUint64 {
		out.HeapBytes = samples[1].Value.Uint64()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hasRate {
		percent := s.percent
		out.CPUPercent = &percent
	}
	return out
}
