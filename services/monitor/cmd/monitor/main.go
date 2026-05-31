// Command monitor polls active servers on an interval: health-checks the source + tools, detects drift,
// updates confidence, and enqueues self_heal/regenerate jobs via the Node enqueue shim. Never opens a
// browser, never calls an LLM. See docs/services/monitor.md.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"mcp/monitor/internal/enqueue"
	"mcp/monitor/internal/monitor"
	"mcp/monitor/internal/poll"
	"mcp/monitor/internal/store"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	dsn := env("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/mcp")
	enqueueURL := env("ENQUEUE_URL", "http://localhost:8081/enqueue")
	interval, _ := time.ParseDuration(env("POLL_INTERVAL", "60s"))

	st, err := store.New(ctx, dsn)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	m := monitor.New(st, poll.New(15*time.Second), enqueue.NewHTTP(enqueueURL))
	log.Printf("monitor started: interval=%s enqueue=%s", interval, enqueueURL)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := m.CheckAll(ctx); err != nil {
			log.Printf("sweep error: %v", err)
		}
		select {
		case <-ctx.Done():
			log.Println("shutting down")
			return
		case <-ticker.C:
		}
	}
}
