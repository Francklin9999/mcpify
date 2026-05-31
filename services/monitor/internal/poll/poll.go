// Package poll is the real HTTP Poller — a cheap GET with a timeout. Read-only; never mutates the source.
package poll

import (
	"context"
	"io"
	"net/http"
	"time"
)

type HTTPPoller struct{ Client *http.Client }

func New(timeout time.Duration) *HTTPPoller {
	return &HTTPPoller{Client: &http.Client{Timeout: timeout}}
}

func (p *HTTPPoller) Fetch(ctx context.Context, url string) (int, string, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, "", true
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		return 0, "", true // transport error / timeout
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 5<<20)) // cap at 5MB
	return resp.StatusCode, string(body), false
}
