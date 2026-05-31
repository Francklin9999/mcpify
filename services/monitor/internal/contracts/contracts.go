// Package contracts mirrors the subset of 01 S4 (queue) and 01 S5 (registry) the Go monitor needs.
// JSON tags MUST match the camelCase @mcp/types shapes - the Node worker validates these via zod.
package contracts

type ToolFailure struct {
	ToolName   string `json:"toolName"`
	ErrorClass string `json:"errorClass"`
	Detail     string `json:"detail"`
	ObservedAt string `json:"observedAt"`
}

// SelfHealJob - produced ONLY by the monitor on a tool failure (01 S4).
type SelfHealJob struct {
	Kind     string      `json:"kind"` // always "self_heal"
	ServerID string      `json:"serverId"`
	ToolName string      `json:"toolName"`
	Failure  ToolFailure `json:"failure"`
}

func NewSelfHealJob(serverID, toolName string, f ToolFailure) SelfHealJob {
	return SelfHealJob{Kind: "self_heal", ServerID: serverID, ToolName: toolName, Failure: f}
}

// RegenerateJob - produced ONLY by the monitor on large drift (01 S4).
type RegenerateJob struct {
	Kind     string `json:"kind"` // always "regenerate"
	ServerID string `json:"serverId"`
	Reason   string `json:"reason"` // "large_drift" | "manual"
}

func NewRegenerateJob(serverID, reason string) RegenerateJob {
	return RegenerateJob{Kind: "regenerate", ServerID: serverID, Reason: reason}
}

// ServerRow is the subset of the servers row the monitor reads.
type ServerRow struct {
	ServerID       string
	URL            string
	Confidence     float64
	Status         string
	CurrentVersion int
}

// HTTPTool is a server's http-execution tool, for replay-based health checks.
type HTTPTool struct {
	Name   string
	Method string
	RawURL string
}
