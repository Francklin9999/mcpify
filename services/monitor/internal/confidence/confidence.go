// Package confidence mirrors the [0,1] clamp invariant from 01 §5 (the canonical aggregateConfidence
// lives in @mcp/types; the monitor only needs the clamp + a health-driven nudge).
package confidence

// Clamp keeps confidence in [0,1] (contract invariant, 01 §5).
func Clamp(n float64) float64 {
	if n < 0 {
		return 0
	}
	if n > 1 {
		return 1
	}
	return n
}

// Nudge raises confidence on a passing health check, lowers it on a failure, bounded to [0,1].
func Nudge(current float64, pass bool, step float64) float64 {
	if pass {
		return Clamp(current + step)
	}
	return Clamp(current - step)
}
