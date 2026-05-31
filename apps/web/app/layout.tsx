import "./globals.css";
import type { ReactNode } from "react";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";

const sans = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata = {
  title: "MCP Forge — turn any website into an MCP server",
  description: "Paste a URL. Get a runnable MCP server an LLM can act with. Generated locally, kept alive automatically.",
};

// Set the theme before first paint (no flash). Default: follow the OS, override with the saved choice.
const themeScript = `(function(){try{var p=new URLSearchParams(location.search).get('theme');var q=(p==='light'||p==='dark')?p:null;var t=q||localStorage.getItem('theme');if(!t){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='light';}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
