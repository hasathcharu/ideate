package procstat

import (
	"strconv"
	"strings"
)

// parseStatm pulls the resident-pages field out of a /proc/<pid>/statm line and
// converts it to bytes.
//
// It is here, without a build tag, purely so it can be tested off Linux: the file
// read that feeds it is one line in rss_linux.go, and putting the arithmetic there
// too would leave the only fiddly part of the Linux path unexercised on every
// machine this is written on.
//
// The fields are `size resident shared text lib data dt`, in **pages** — the second
// is the one wanted, and the page size is a property of the machine rather than a
// constant worth hardcoding.
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
