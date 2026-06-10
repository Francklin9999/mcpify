package monitor

import (
	"context"
	"testing"

	"mcp/monitor/internal/contracts"
	"mcp/monitor/internal/detect"
)

// Fakes
type fakePoller struct{ resp map[string]struct {
	status   int
	body     string
	timedOut bool
} }

func (f *fakePoller) Fetch(_ context.Context, url string) (int, string, bool) {
	r, ok := f.resp[url]
	if !ok {
		return 200, "default body", false
	}
	return r.status, r.body, r.timedOut
}

type healthEvent struct {
	tool       *string
	pass       bool
	errorClass string
}

type fakeStore struct {
	servers   []contracts.ServerRow
	tools     []contracts.HTTPTool
	lastHash  string
	lastLen   int
	events    []healthEvent
	confByID  map[string]float64
	statusByID map[string]string
}

func newFakeStore() *fakeStore {
	return &fakeStore{confByID: map[string]float64{}, statusByID: map[string]string{}}
}
func (s *fakeStore) ListActiveServers(context.Context) ([]contracts.ServerRow, error) { return s.servers, nil }
func (s *fakeStore) ListHTTPTools(context.Context, string, int) ([]contracts.HTTPTool, error) {
	return s.tools, nil
}
func (s *fakeStore) LastSnapshot(context.Context, string) (string, int, error) {
	return s.lastHash, s.lastLen, nil
}
func (s *fakeStore) WriteHealthEvent(_ context.Context, _ string, tool *string, pass bool, ec, _ string, _ int) error {
	s.events = append(s.events, healthEvent{tool, pass, ec})
	return nil
}
func (s *fakeStore) UpdateConfidence(_ context.Context, id string, c float64) error {
	s.confByID[id] = c
	return nil
}
func (s *fakeStore) SetStatus(_ context.Context, id, st string) error { s.statusByID[id] = st; return nil }

type fakeEnqueuer struct{ jobs []any }

func (e *fakeEnqueuer) Enqueue(_ context.Context, job any) error { e.jobs = append(e.jobs, job); return nil }

func srv() contracts.ServerRow {
	return contracts.ServerRow{ServerID: "s1", URL: "https://src.example.com", Confidence: 0.8, Status: "active", CurrentVersion: 1}
}

// Tests
func TestFailingToolProducesExactlyOneSelfHealJob(t *testing.T) {
	store := newFakeStore()
	store.servers = []contracts.ServerRow{srv()}
	store.tools = []contracts.HTTPTool{
		{Name: "get_a", Method: "GET", RawURL: "https://api.example.com/a"},
		{Name: "get_b", Method: "GET", RawURL: "https://api.example.com/b"},
	}
	poller := &fakePoller{resp: map[string]struct {
		status   int
		body     string
		timedOut bool
	}{
		"https://src.example.com":  {200, "ok", false},
		"https://api.example.com/a": {200, "", false},
		"https://api.example.com/b": {500, "", false}, // b is broken
	}}
	enq := &fakeEnqueuer{}
	m := New(store, poller, enq)
	if err := m.CheckServer(context.Background(), srv()); err != nil {
		t.Fatal(err)
	}
	if len(enq.jobs) != 1 {
		t.Fatalf("expected exactly 1 job, got %d", len(enq.jobs))
	}
	job, ok := enq.jobs[0].(contracts.SelfHealJob)
	if !ok || job.Kind != "self_heal" || job.ToolName != "get_b" || job.Failure.ErrorClass != "http_5xx" {
		t.Fatalf("bad self_heal job: %+v", enq.jobs[0])
	}
}

func TestLargeDriftProducesRegenerateAndSetsRegenerating(t *testing.T) {
	store := newFakeStore()
	store.servers = []contracts.ServerRow{srv()}
	store.lastHash = "sha256:OLD"
	store.lastLen = 100
	poller := &fakePoller{resp: map[string]struct {
		status   int
		body     string
		timedOut bool
	}{
		"https://src.example.com": {200, makeBody(500), false}, // 5x larger -> large drift
	}}
	enq := &fakeEnqueuer{}
	m := New(store, poller, enq)
	if err := m.CheckServer(context.Background(), srv()); err != nil {
		t.Fatal(err)
	}
	if store.statusByID["s1"] != "regenerating" {
		t.Errorf("status should be regenerating, got %q", store.statusByID["s1"])
	}
	if len(enq.jobs) != 1 {
		t.Fatalf("expected 1 regenerate job, got %d", len(enq.jobs))
	}
	job, ok := enq.jobs[0].(contracts.RegenerateJob)
	if !ok || job.Reason != "large_drift" {
		t.Fatalf("bad regenerate job: %+v", enq.jobs[0])
	}
}

func TestSmallDriftEnqueuesDeepenAndRaisesConfidence(t *testing.T) {
	store := newFakeStore()
	store.servers = []contracts.ServerRow{srv()}
	store.lastHash = "sha256:OLD"
	store.lastLen = 100
	store.tools = []contracts.HTTPTool{{Name: "get_a", Method: "GET", RawURL: "https://api.example.com/a"}}
	poller := &fakePoller{resp: map[string]struct {
		status   int
		body     string
		timedOut bool
	}{
		"https://src.example.com":   {200, makeBody(105), false}, // tiny change -> small drift, no regen
		"https://api.example.com/a": {200, "", false},
	}}
	enq := &fakeEnqueuer{}
	m := New(store, poller, enq)
	if err := m.CheckServer(context.Background(), srv()); err != nil {
		t.Fatal(err)
	}
	// Small drift = the source changed modestly -> continuous re-discovery: exactly ONE deepen job, no regen.
	if len(enq.jobs) != 1 {
		t.Fatalf("small drift should enqueue exactly one deepen job, got %d", len(enq.jobs))
	}
	job, ok := enq.jobs[0].(contracts.DeepenJob)
	if !ok || job.Kind != "deepen" || job.ServerID != "s1" || job.LegalMode != "safe" {
		t.Fatalf("expected a deepen job for s1 (safe), got %+v", enq.jobs[0])
	}
	if store.statusByID["s1"] == "regenerating" {
		t.Errorf("small drift must NOT mark the server regenerating")
	}
	if c := store.confByID["s1"]; c <= 0.8 || c > 1.0 {
		t.Errorf("confidence should rise within bounds, got %v", c)
	}
}

func TestNoDriftAndHealthyToolsEnqueuesNothing(t *testing.T) {
	store := newFakeStore()
	store.servers = []contracts.ServerRow{srv()}
	body := makeBody(120)
	store.lastHash = detect.DomHash(body) // identical hash => DriftNone
	store.lastLen = len(body)
	store.tools = []contracts.HTTPTool{{Name: "get_a", Method: "GET", RawURL: "https://api.example.com/a"}}
	poller := &fakePoller{resp: map[string]struct {
		status   int
		body     string
		timedOut bool
	}{
		"https://src.example.com":   {200, body, false}, // unchanged -> no drift, no discovery
		"https://api.example.com/a": {200, "", false},
	}}
	enq := &fakeEnqueuer{}
	m := New(store, poller, enq)
	if err := m.CheckServer(context.Background(), srv()); err != nil {
		t.Fatal(err)
	}
	if len(enq.jobs) != 0 {
		t.Fatalf("an unchanged, healthy server should enqueue nothing, got %d", len(enq.jobs))
	}
	if c := store.confByID["s1"]; c <= 0.8 || c > 1.0 {
		t.Errorf("confidence should rise within bounds, got %v", c)
	}
}

func TestRediscoverDisabledSuppressesDeepenOnSmallDrift(t *testing.T) {
	store := newFakeStore()
	store.servers = []contracts.ServerRow{srv()}
	store.lastHash = "sha256:OLD"
	store.lastLen = 100
	poller := &fakePoller{resp: map[string]struct {
		status   int
		body     string
		timedOut bool
	}{
		"https://src.example.com": {200, makeBody(105), false},
	}}
	enq := &fakeEnqueuer{}
	m := New(store, poller, enq)
	m.Rediscover = false // MONITOR_REDISCOVER=0
	if err := m.CheckServer(context.Background(), srv()); err != nil {
		t.Fatal(err)
	}
	if len(enq.jobs) != 0 {
		t.Fatalf("with re-discovery disabled, small drift should enqueue nothing, got %d", len(enq.jobs))
	}
}

func makeBody(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'x'
	}
	return string(b)
}
