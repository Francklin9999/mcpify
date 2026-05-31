import type { ReactNode } from "react";
import { AppRail } from "@/components/AppRail";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <AppRail />
      <main className="main">{children}</main>
      <aside className="context">
        <div className="assistant-card">
          <p className="eyebrow">Assistant</p>
          <h2>Page assistant</h2>
          <ul className="assistant-tasks">
            <li><b>Generate</b> a server from a URL</li>
            <li><b>Explain</b> a server's tools</li>
            <li><b>Diagnose</b> a broken server</li>
          </ul>
          <div className="assistant-log">
            <p>Ask about any server, or paste a URL on the Generate tab to build one.</p>
          </div>
          <form className="assistant-input">
            <input className="field" placeholder="Ask anything..." />
            <button className="primary-btn" type="button">Ask</button>
          </form>
        </div>
      </aside>
    </div>
  );
}
