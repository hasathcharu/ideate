package procstat

import (
	"strconv"
	"strings"
)

// parseStatm pulls the resident-pages field out of a /proc/<pid>/statm line and converts it to
// bytes.
func parseStatm(data []byte, pageSize int) (uint64, bool) {
	if pageSize <= 0 {
		return 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) < 2 {
		return 0, false
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return pages * uint64(pageSize), true
}
