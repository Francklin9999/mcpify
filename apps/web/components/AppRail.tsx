"use client";

import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";

const LINKS = [
  { href: "/library", label: "Library" },
  { href: "/generate", label: "Generate" },
  { href: "/monitor", label: "Monitor" },
];

export function AppRail() {
  const path = usePathname();
  return (
    <aside className="rail">
      <a className="brand" href="/">
        <span className="dot">◆</span> MCP Forge
      </a>
      <nav>
        {LINKS.map((l) => {
          const active = path === l.href || (l.href !== "/library" && path.startsWith(l.href));
          return (
            <a key={l.href} href={l.href} className={active ? "active" : ""}>
              {l.label}
            </a>
          );
        })}
      </nav>
      <div className="rail-foot">
        <span className="ver">v0.1 · local</span>
        <ThemeToggle />
      </div>
    </aside>
  );
}
