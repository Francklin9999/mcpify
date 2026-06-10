// Package enqueue pushes jobs onto the queue. The monitor does NOT replicate BullMQ's Redis structures
// from Go (fragile, version-coupled); it POSTs to a thin Node enqueue shim that calls queue.add() - the
// doc's recommended alternative. The queue stays BullMQ/Redis; only the producer path is HTTP.
package enqueue

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

type Enqueuer interface {
	Enqueue(ctx context.Context, job any) error
}

type HTTPEnqueuer struct {
	URL    string
	Client *http.Client
}

func NewHTTP(url string) *HTTPEnqueuer {
	return &HTTPEnqueuer{URL: url, Client: &http.Client{Timeout: enqueueTimeout()}}
}

func enqueueTimeout() time.Duration {
	raw := os.Getenv("ENQUEUE_HTTP_TIMEOUT")
	if raw == "" {
		return 10 * time.Second
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return 10 * time.Second
	}
	return d
}

func (e *HTTPEnqueuer) Enqueue(ctx context.Context, job any) error {
	body, err := json.Marshal(job)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token := os.Getenv("ENQUEUE_TOKEN"); token != "" {
		req.Header.Set("X-Enqueue-Token", token)
	}
	resp, err := e.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("enqueue failed: %d", resp.StatusCode)
	}
	return nil
}
