import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="mk-header">
        <div className="mk-header-inner">
          <a className="brand" href="/">
            <span className="dot">◆</span> MCP Forge
          </a>
          <nav className="mk-nav">
            <a className="navlink" href="#how">How it works</a>
            <a className="navlink" href="#confidence">Confidence</a>
            <a className="navlink" href="/library">Library</a>
            <ThemeToggle />
            <a className="primary-btn" href="/generate">Generate a server</a>
          </nav>
        </div>
      </header>
      {children}
      <footer className="mk-footer">
        <div className="mk-footer-inner">
          <span>◆ MCP Forge — generate, don't integrate.</span>
          <span>Generated servers run locally. Your machine, your credentials.</span>
        </div>
      </footer>
    </>
  );
}
