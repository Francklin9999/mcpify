package detect

import "testing"

func TestDomHashFormatAndParity(t *testing.T) {
	// sha256("test") - identical to Python hashlib.sha256(b"test").hexdigest(), so monitor hashes are
	// directly comparable to the scraper's "sha256:"+hexdigest() (cross-language change detection).
	got := DomHash("test")
	want := "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
	if got != want {
		t.Fatalf("DomHash mismatch:\n got %s\nwant %s", got, want)
	}
}

func TestClassifyStatus(t *testing.T) {
	cases := []struct {
		status   int
		timedOut bool
		pass     bool
		class    string
	}{
		{200, false, true, ""},
		{301, false, true, ""},
		{404, false, false, "http_4xx"},
		{503, false, false, "http_5xx"},
		{0, true, false, "timeout"},
	}
	for _, c := range cases {
		h := ClassifyStatus(c.status, c.timedOut)
		if h.Pass != c.pass || h.ErrorClass != c.class {
			t.Errorf("ClassifyStatus(%d,%v) = %+v, want pass=%v class=%q", c.status, c.timedOut, h, c.pass, c.class)
		}
	}
}

func TestClassifyDrift(t *testing.T) {
	if ClassifyDrift("", "sha256:x", 100, 100, 0.3) != DriftNone {
		t.Error("no baseline must be DriftNone")
	}
	if ClassifyDrift("sha256:a", "sha256:a", 100, 100, 0.3) != DriftNone {
		t.Error("same hash must be DriftNone")
	}
	if ClassifyDrift("sha256:a", "sha256:b", 100, 110, 0.3) != DriftSmall {
		t.Error("10% change must be DriftSmall")
	}
	if ClassifyDrift("sha256:a", "sha256:b", 100, 200, 0.3) != DriftLarge {
		t.Error("100% change must be DriftLarge")
	}
}
