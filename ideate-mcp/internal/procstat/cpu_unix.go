//go:build unix

package procstat

import (
	"syscall"
	"time"
)

// cpuSeconds is the process's cumulative user+system CPU time.
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
