package confidence

import "testing"

func TestClamp(t *testing.T) {
	if Clamp(1.5) != 1 || Clamp(-0.2) != 0 || Clamp(0.4) != 0.4 {
		t.Fatal("Clamp must bound to [0,1]")
	}
}

func TestNudge(t *testing.T) {
	if Nudge(0.5, true, 0.1) != 0.6 {
		t.Error("pass should raise")
	}
	if Nudge(0.5, false, 0.1) != 0.4 {
		t.Error("fail should lower")
	}
	if Nudge(0.95, true, 0.1) != 1.0 {
		t.Error("pass must clamp at 1")
	}
	if Nudge(0.05, false, 0.1) != 0.0 {
		t.Error("fail must clamp at 0")
	}
}
