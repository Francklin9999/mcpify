import type { RegistryEntry } from "@mcp/types";
import { ServerCard } from "@/components/ServerCard";

const tabs = [
  { label: "All", href: "/library" },
  { label: "Curated", href: "/library?tier=curated" },
  { label: "Auto-gen", href: "/library?tier=auto_gen" },
];

export function LibraryView({
  entries,
  activeTier,
  query,
}: {
  entries: RegistryEntry[];
  activeTier?: string;
  query?: string;
}) {
  return (
    <section className="workspace">
      <div className="section-head">
        <div>
          <p className="eyebrow">Library</p>
          <h2>Generated MCP servers</h2>
        </div>
        <form className="search" action="/library">
          {activeTier ? <input type="hidden" name="tier" value={activeTier} /> : null}
          <input className="field" name="q" defaultValue={query} placeholder="Search sites or tools" />
          <button className="primary-btn" type="submit">Search</button>
        </form>
      </div>

      <div className="topbar" aria-label="Registry filters">
        {tabs.map((tab) => {
          const active = (!activeTier && tab.label === "All") || activeTier === tab.href.split("tier=")[1];
          return (
            <a className={`tab ${active ? "active" : ""}`} href={tab.href} key={tab.label}>
              {tab.label}
            </a>
          );
        })}
      </div>

      <div className="list">
        {entries.map((entry) => (
          <ServerCard entry={entry} key={entry.serverId} />
        ))}
        {entries.length === 0 ? <div className="empty">No servers match this view.</div> : null}
      </div>
    </section>
  );
}
