//go:build linux

package procstat

import (
	"os"
	"syscall"
)

// residentBytes reads RSS out of /proc/self/statm.
func residentBytes() (uint64, bool) {
	buf, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0, false
	}
	return parseStatm(buf, syscall.Getpagesize())
}
