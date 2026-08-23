//go:build !unix

package procstat

// cpuSeconds has no answer off unix. The service is built for Linux containers and
// developed on macOS, so this exists to keep the package compiling under a
// cross-build rather than because anyone runs it here.
func cpuSeconds() (float64, bool) { return 0, false }
