//go:build !linux

package procstat

// residentBytes has no portable answer off Linux, and reporting a zero would read
// as "this process holds no memory". The snapshot omits the field instead and
// leaves RuntimeBytes — which is always available — to stand in for it.
func residentBytes() (uint64, bool) { return 0, false }
