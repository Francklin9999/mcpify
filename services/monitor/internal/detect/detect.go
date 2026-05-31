// Package detect holds the monitor's pure detection logic: DOM hashing, health classification, and
// drift classification. No I/O - fully unit-testable.
package detect

import (
	"crypto/sha256"
	"encoding/hex"
)

// DomHash matches the scraper's Python format exactly ("sha256:" + lowercase hex) so hashes are comparable.
func DomHash(html string) string {
	sum := sha256.Sum256([]byte(html))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Health is the result of a health check, mapped to ToolFailure.errorClass (01 S4).
type Health struct {
	Pass       bool
	ErrorClass string // "" when Pass
}

// ClassifyStatus maps an HTTP status (or timeout) to pass/fail + errorClass.
func ClassifyStatus(status int, timedOut bool) Health {
	switch {
	case timedOut:
		return Health{false, "timeout"}
	case status >= 200 && status < 400:
		return Health{true, ""}
	case status >= 400 && status < 500:
		return Health{false, "http_4xx"}
	default: // 5xx and anything unexpected
		return Health{false, "http_5xx"}
	}
}

// Drift classifies a page change between two snapshots.
type Drift int

const (
	DriftNone Drift = iota
	DriftSmall
	DriftLarge
)

// ClassifyDrift: same hash => none; different hash => small/large by fractional content-length change.
// No baseline (empty oldHash) => none. `threshold` is the fractional change above which drift is "large".
func ClassifyDrift(oldHash, newHash string, oldLen, newLen int, threshold float64) Drift {
	if oldHash == "" || oldHash == newHash {
		return DriftNone
	}
	denom := oldLen
	if denom < 1 {
		denom = 1
	}
	ratio := float64(absInt(newLen-oldLen)) / float64(denom)
	if ratio > threshold {
		return DriftLarge
	}
	return DriftSmall
}

func absInt(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
