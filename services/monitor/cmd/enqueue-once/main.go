// Tiny helper for the cross-language seam test: posts one job via the REAL Go HTTPEnqueuer to the Node
// shim. Usage: ENQUEUE_URL=... go run ./cmd/enqueue-once
package main

import (
	"context"
	"log"
	"os"

	"mcp/monitor/internal/contracts"
	"mcp/monitor/internal/enqueue"
)

func main() {
	url := os.Getenv("ENQUEUE_URL")
	e := enqueue.NewHTTP(url)
	job := contracts.NewRegenerateJob("00000000-0000-4000-8000-000000000000", "large_drift")
	if err := e.Enqueue(context.Background(), job); err != nil {
		log.Fatalf("enqueue failed: %v", err)
	}
	log.Println("enqueued via Go HTTPEnqueuer")
}
