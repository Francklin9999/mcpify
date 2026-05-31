import { listRegistry } from "@/lib/registry";

export const dynamic = "force-dynamic";

export default async function MonitorPage() {
  const entries = await listRegistry();
  const counts = {
    active: entries.filter((entry) => entry.status === "active").length,
    degraded: entries.filter((entry) => entry.status === "degraded").length,
    broken: entries.filter((entry) => entry.status === "broken").length,
    regenerating: entries.filter((entry) => entry.status === "regenerating").length,
  };

  return (
    <section className="workspace">
      <div className="section-head">
        <div>
          <p className="eyebrow">Monitor</p>
          <h2>Server health</h2>
        </div>
      </div>
      <div className="metrics">
        {Object.entries(counts).map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="tool-panel">
        <div className="version-list">
          {entries.map((entry) => (
            <a href={`/servers/${entry.serverId}`} key={entry.serverId}>
              <span>{entry.title}</span>
              <span>{entry.status}</span>
              <span>{Math.round(entry.confidence * 100)}%</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
