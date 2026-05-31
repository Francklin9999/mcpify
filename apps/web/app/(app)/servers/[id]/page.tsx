import { notFound } from "next/navigation";
import { confidenceBand, pct } from "@/lib/confidence";
import { getServerDetail } from "@/lib/registry";

export const dynamic = "force-dynamic";

export default async function ServerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const server = await getServerDetail(id);
  if (!server) notFound();
  const band = confidenceBand(server.confidence, server.status);
  const tools = (server as typeof server & { tools?: { name: string; description: string; confidence?: number }[] }).tools ?? [];

  return (
    <section className="workspace">
      <div className="detail-head">
        <div>
          <p className="eyebrow">{server.tier === "curated" ? "Curated" : "Auto-gen"}</p>
          <h2>{server.title}</h2>
          <p className="muted truncate">{server.url}</p>
        </div>
        <div className="band detail-band" style={{ background: `var(${band.colorVar})` }}>
          <span className="pct">{pct(server.confidence)}%</span>
          <span className="label">{band.label}</span>
        </div>
      </div>

      <div className="metrics">
        <div><span>Status</span><strong>{server.status}</strong></div>
        <div><span>Installs</span><strong>{server.installCount.toLocaleString()}</strong></div>
        <div><span>Current version</span><strong>v{server.currentVersion}</strong></div>
        <div><span>Last parsed</span><strong>{new Date(server.lastParsedAt).toLocaleDateString()}</strong></div>
      </div>

      <div className="tool-panel">
        <div className="snippet-head">
          <h3>Versions</h3>
          <a className="primary-btn" href={`/api/servers/${server.serverId}/download/${server.currentVersion}`}>Install current</a>
        </div>
        <div className="version-list">
          {server.versions.map((version) => (
            <a href={`/api/servers/${server.serverId}/download/${version.version}`} key={version.version}>
              <span>v{version.version}</span>
              <span>{version.toolCount} tools</span>
              <span>{version.createdBy}</span>
            </a>
          ))}
        </div>
      </div>

      {tools.length ? (
        <div className="tool-panel">
          <div className="snippet-head">
            <h3>Tools</h3>
            <span className="muted">{tools.length} available</span>
          </div>
          <div className="version-list">
            {tools.map((tool) => (
              <div key={tool.name}>
                <span>{tool.name}</span>
                <span>{tool.description}</span>
                <span>{typeof tool.confidence === "number" ? `${Math.round(tool.confidence * 100)}%` : "verified"}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
