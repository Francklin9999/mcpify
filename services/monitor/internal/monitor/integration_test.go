package monitor

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"mcp/monitor/internal/contracts"
	"mcp/monitor/internal/poll"
	"mcp/monitor/internal/store"
)

// Real bar: real Postgres + real HTTP poller (httptest) + fake enqueuer. Gated on DATABASE_URL.
func TestMonitorAgainstRealPostgres(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set - integration test skipped")
	}
	ctx := context.Background()

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/bad":
			w.WriteHeader(500)
		default:
			fmt.Fprint(w, "a healthy server-rendered page with stable content")
		}
	}))
	defer ts.Close()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	serverID := uuid.NewString()
	mustExec(ctx, t, pool, `DELETE FROM servers WHERE url = $1`, ts.URL)
	mustExec(ctx, t, pool,
		`INSERT INTO servers (server_id, url, title, tier, confidence, status, current_version, last_parsed_at)
		 VALUES ($1, $2, 'T', 'auto_gen', 0.8, 'active', 1, now())`, serverID, ts.URL)
	mustExec(ctx, t, pool,
		`INSERT INTO server_versions (server_id, version, artifact_url, tool_count, created_by)
		 VALUES ($1, 1, 'file:///x', 2, 'auto')`, serverID)
	toolJSON := func(name, url string) string {
		return fmt.Sprintf(`{"name":%q,"execution":{"kind":"http","request":{"method":"GET","rawUrl":%q}}}`, name, url)
	}
	mustExec(ctx, t, pool,
		`INSERT INTO tools (server_id, version, name, confidence, execution_kind, definition)
		 VALUES ($1, 1, 'get_good', 0.9, 'http', $2)`, serverID, toolJSON("get_good", ts.URL+"/api/good"))
	mustExec(ctx, t, pool,
		`INSERT INTO tools (server_id, version, name, confidence, execution_kind, definition)
		 VALUES ($1, 1, 'get_bad', 0.9, 'http', $2)`, serverID, toolJSON("get_bad", ts.URL+"/api/bad"))

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	enq := &fakeEnqueuer{}
	m := New(st, poll.New(10*time.Second), enq)

	srv := contracts.ServerRow{ServerID: serverID, URL: ts.URL, Confidence: 0.8, Status: "active", CurrentVersion: 1}
	if err := m.CheckServer(ctx, srv); err != nil {
		t.Fatal(err)
	}

	// Exactly one self_heal job, for the failing tool.
	if len(enq.jobs) != 1 {
		t.Fatalf("expected 1 job, got %d: %+v", len(enq.jobs), enq.jobs)
	}
	job, ok := enq.jobs[0].(contracts.SelfHealJob)
	if !ok || job.ToolName != "get_bad" || job.Failure.ErrorClass != "http_5xx" {
		t.Fatalf("bad self_heal job: %+v", enq.jobs[0])
	}

	// Real rows: health_events written (whole-server + per-tool), confidence updated.
	var healthCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM health_events WHERE server_id = $1`, serverID).Scan(&healthCount); err != nil {
		t.Fatal(err)
	}
	if healthCount != 3 { // 1 whole-server + 2 tools
		t.Errorf("expected 3 health_events, got %d", healthCount)
	}
	var conf float64
	if err := pool.QueryRow(ctx, `SELECT confidence FROM servers WHERE server_id = $1`, serverID).Scan(&conf); err != nil {
		t.Fatal(err)
	}
	if conf <= 0.8 || conf > 1.0 {
		t.Errorf("source health passed -> confidence should rise within bounds, got %v", conf)
	}
}

func mustExec(ctx context.Context, t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("seed exec failed: %v\nSQL: %s", err, sql)
	}
}
