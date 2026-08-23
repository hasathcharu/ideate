//go:build linux

package procstat

import (
	"os"
	"syscall"
)

// residentBytes reads RSS out of /proc/self/statm.
//
// statm rather than /proc/self/status: the same figure without scanning a
// forty-line text file for a VmRSS key, and its second field is exactly what is
// wanted. Both files exist in a distroless container — /proc belongs to the kernel,
// not to the image — which is why this needs nothing added to the image.
//
// The parsing lives in parseStatm, which has no build tag, so it stays testable on
// the machines this is developed on rather than only in CI.
func residentBytes() (uint64, bool) {
	buf, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0, false
	}
	return parseStatm(buf, syscall.Getpagesize())
}
