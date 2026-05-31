import type { RegistryEntry } from "@mcp/types";
import { confidenceBand, pct } from "@/lib/confidence";

export function ServerCard({ entry }: { entry: RegistryEntry }) {
  const band = confidenceBand(entry.confidence, entry.status);
  return (
    <article className="card">
      <div className="card-main">
        <div className="card-kicker">
          <span className={`status-dot ${entry.status}`} />
          <span>{entry.tier === "curated" ? "Curated" : "Auto-gen"}</span>
          <span>v{entry.currentVersion}</span>
        </div>
        <h3>
          <a href={`/servers/${entry.serverId}`}>{entry.title}</a>
        </h3>
        <div className="meta truncate">{entry.url}</div>
        <div className="card-footer">
          <span>{entry.installCount.toLocaleString()} installs</span>
          <span>{new Date(entry.lastParsedAt).toLocaleDateString()}</span>
          <span className={`status ${entry.status}`}>{entry.status}</span>
        </div>
        <div className="actions">
          <a className="quiet-btn" href={`/servers/${entry.serverId}`}>Details</a>
          <a className="primary-btn" href={`/api/servers/${entry.serverId}/download/${entry.currentVersion}`}>Install</a>
        </div>
      </div>
      <div className="band" style={{ background: `var(${band.colorVar})` }}>
        <span className="pct">{pct(entry.confidence)}%</span>
        <span className="label">{band.label}</span>
      </div>
    </article>
  );
}
