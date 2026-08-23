//go:build unix

package procstat

import (
	"syscall"
	"time"
)

// cpuSeconds is the process's cumulative user+system CPU time.
//
// getrusage rather than /proc/self/stat: it is one syscall with no parsing, it is
// the same accounting `top` and the kernel's own cgroup limits use, and it works
// unchanged on the macOS boxes this is developed on as well as the Linux one it
// ships to. RUSAGE_SELF covers every thread in the process.
//
// Deliberately *not* reading Rusage.Maxrss for the memory number: its unit is
// kilobytes on Linux and bytes on Darwin, so a portable reading of it needs a
// per-GOOS conversion table to say anything true — and it is a peak, where an
// operator watching a memory limit needs the current figure. residentBytes reads
// that instead.
func cpuSeconds() (float64, bool) {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0, false
	}
	return timeval(ru.Utime) + timeval(ru.Stime), true
}

// timeval converts through time.Duration rather than doing the arithmetic inline
// because Timeval's fields are int32 on some platforms and int64 on others, and
// the conversions are what silence that difference.
func timeval(tv syscall.Timeval) float64 {
	return (time.Duration(tv.Sec)*time.Second + time.Duration(tv.Usec)*time.Microsecond).Seconds()
}
