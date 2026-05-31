// Package monitor orchestrates the two detectors over interfaces (Store/Poller/Enqueuer) so the logic is
// testable with fakes. It NEVER opens a browser and NEVER calls an LLM - it only detects and enqueues.
package monitor

import (
	"context"
	"fmt"
	"time"

	"mcp/monitor/internal/confidence"
	"mcp/monitor/internal/contracts"
	"mcp/monitor/internal/detect"
	"mcp/monitor/internal/enqueue"
)

type Poller interface {
	// Fetch GETs url, returning status, body, and whether it timed out. A transport error is timedOut=true.
	Fetch(ctx context.Context, url string) (status int, body string, timedOut bool)
}

type Store interface {
	ListActiveServers(ctx context.Context) ([]contracts.ServerRow, error)
	ListHTTPTools(ctx context.Context, serverID string, version int) ([]contracts.HTTPTool, error)
	LastSnapshot(ctx context.Context, serverID string) (domHash string, contentLength int, err error)
	WriteHealthEvent(ctx context.Context, serverID string, toolName *string, pass bool, errorClass, domHash string, contentLength int) error
	UpdateConfidence(ctx context.Context, serverID string, c float64) error
	SetStatus(ctx context.Context, serverID, status string) error
}

type Monitor struct {
	Store          Store
	Poller         Poller
	Enqueuer       enqueue.Enqueuer
	Step           float64 // confidence nudge per health result
	DriftThreshold float64 // fractional content-length change above which drift is "large"
	Now            func() time.Time
}

func New(s Store, p Poller, e enqueue.Enqueuer) *Monitor {
	return &Monitor{Store: s, Poller: p, Enqueuer: e, Step: 0.05, DriftThreshold: 0.3, Now: time.Now}
}

// CheckAll polls every active server once.
func (m *Monitor) CheckAll(ctx context.Context) error {
	servers, err := m.Store.ListActiveServers(ctx)
	if err != nil {
		return err
	}
	for _, srv := range servers {
		if err := m.CheckServer(ctx, srv); err != nil {
			return fmt.Errorf("check %s: %w", srv.ServerID, err)
		}
	}
	return nil
}

// CheckServer runs the change detector then (if the source is healthy) the tool health checker.
func (m *Monitor) CheckServer(ctx context.Context, srv contracts.ServerRow) error {
 // Change detector: fetch the SOURCE page (not user instances), hash + size, classify drift.
	status, body, timedOut := m.Poller.Fetch(ctx, srv.URL)
	health := detect.ClassifyStatus(status, timedOut)
	newHash := detect.DomHash(body)
	newLen := len(body)
	oldHash, oldLen, err := m.Store.LastSnapshot(ctx, srv.ServerID)
	if err != nil {
		return err
	}
	if err := m.Store.WriteHealthEvent(ctx, srv.ServerID, nil, health.Pass, health.ErrorClass, newHash, newLen); err != nil {
		return err
	}
	if err := m.Store.UpdateConfidence(ctx, srv.ServerID, confidence.Nudge(srv.Confidence, health.Pass, m.Step)); err != nil {
		return err
	}

	if health.Pass {
		switch detect.ClassifyDrift(oldHash, newHash, oldLen, newLen, m.DriftThreshold) {
		case detect.DriftLarge:
			// Large drift -> regenerate the whole server; mark it regenerating and stop (don't tool-check).
			if err := m.Store.SetStatus(ctx, srv.ServerID, "regenerating"); err != nil {
				return err
			}
			return m.Enqueuer.Enqueue(ctx, contracts.NewRegenerateJob(srv.ServerID, "large_drift"))
		}
	}

 // Tool health checker: replay each http tool's endpoint (read-only reachability probe, v1).
	tools, err := m.Store.ListHTTPTools(ctx, srv.ServerID, srv.CurrentVersion)
	if err != nil {
		return err
	}
	for _, tool := range tools {
		ts, _, tTimedOut := m.Poller.Fetch(ctx, tool.RawURL)
		th := detect.ClassifyStatus(ts, tTimedOut)
		name := tool.Name
		if err := m.Store.WriteHealthEvent(ctx, srv.ServerID, &name, th.Pass, th.ErrorClass, "", 0); err != nil {
			return err
		}
		if !th.Pass {
			failure := contracts.ToolFailure{
				ToolName:   tool.Name,
				ErrorClass: th.ErrorClass,
				Detail:     fmt.Sprintf("health probe %s -> %d", tool.RawURL, ts),
				ObservedAt: m.Now().UTC().Format(time.RFC3339),
			}
			if err := m.Enqueuer.Enqueue(ctx, contracts.NewSelfHealJob(srv.ServerID, tool.Name, failure)); err != nil {
				return err
			}
		}
	}
	return nil
}
