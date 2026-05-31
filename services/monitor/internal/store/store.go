// Package store is the pgx-backed Store implementation over the @mcp/db schema (02). Postgres-only -
// the monitor reads the last dom_hash/content_length from health_events (no Redis dependency).
package store

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"

	"mcp/monitor/internal/contracts"
)

type Store struct{ pool *pgxpool.Pool }

func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) ListActiveServers(ctx context.Context) ([]contracts.ServerRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT server_id, url, confidence, status, COALESCE(current_version, 0)
		   FROM servers WHERE status = 'active'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []contracts.ServerRow
	for rows.Next() {
		var r contracts.ServerRow
		if err := rows.Scan(&r.ServerID, &r.URL, &r.Confidence, &r.Status, &r.CurrentVersion); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// toolDef is the slice of ToolDefinition jsonb the monitor needs to replay an http tool.
type toolDef struct {
	Execution struct {
		Request struct {
			Method string `json:"method"`
			RawURL string `json:"rawUrl"`
		} `json:"request"`
	} `json:"execution"`
}

func (s *Store) ListHTTPTools(ctx context.Context, serverID string, version int) ([]contracts.HTTPTool, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT name, definition FROM tools
		  WHERE server_id = $1 AND version = $2 AND execution_kind = 'http'`, serverID, version)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []contracts.HTTPTool
	for rows.Next() {
		var name string
		var def []byte
		if err := rows.Scan(&name, &def); err != nil {
			return nil, err
		}
		var d toolDef
		if err := json.Unmarshal(def, &d); err != nil {
			continue // skip an unparseable row rather than failing the whole sweep
		}
		out = append(out, contracts.HTTPTool{Name: name, Method: d.Execution.Request.Method, RawURL: d.Execution.Request.RawURL})
	}
	return out, rows.Err()
}

func (s *Store) LastSnapshot(ctx context.Context, serverID string) (string, int, error) {
	var hash string
	var length int
	err := s.pool.QueryRow(ctx,
		`SELECT dom_hash, COALESCE(content_length, 0) FROM health_events
		  WHERE server_id = $1 AND dom_hash IS NOT NULL
		  ORDER BY observed_at DESC LIMIT 1`, serverID).Scan(&hash, &length)
	if err != nil {
		return "", 0, nil // no baseline yet (no rows) - treat as empty
	}
	return hash, length, nil
}

func (s *Store) WriteHealthEvent(ctx context.Context, serverID string, toolName *string, pass bool, errorClass, domHash string, contentLength int) error {
	result := "fail"
	if pass {
		result = "pass"
	}
	var ec, dh *string
	var cl *int
	if errorClass != "" {
		ec = &errorClass
	}
	if domHash != "" {
		dh = &domHash
		cl = &contentLength
	}
	_, err := s.pool.Exec(ctx,
		`INSERT INTO health_events (server_id, tool_name, result, error_class, dom_hash, content_length)
		 VALUES ($1, $2, $3, $4, $5, $6)`, serverID, toolName, result, ec, dh, cl)
	return err
}

func (s *Store) UpdateConfidence(ctx context.Context, serverID string, c float64) error {
	_, err := s.pool.Exec(ctx, `UPDATE servers SET confidence = $2 WHERE server_id = $1`, serverID, c)
	return err
}

func (s *Store) SetStatus(ctx context.Context, serverID, status string) error {
	_, err := s.pool.Exec(ctx, `UPDATE servers SET status = $2 WHERE server_id = $1`, serverID, status)
	return err
}
