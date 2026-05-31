import type { RegistryEntry, ServerVersion } from "@mcp/types";

export const sampleRegistry: RegistryEntry[] = [
  {
    serverId: "11111111-1111-4111-8111-111111111111",
    url: "https://example.com/products",
    title: "Example Products",
    tier: "curated",
    confidence: 0.97,
    installCount: 1284,
    lastParsedAt: "2026-05-29T18:10:00.000Z",
    status: "active",
    currentVersion: 4,
  },
  {
    serverId: "22222222-2222-4222-8222-222222222222",
    url: "https://docs.example.dev",
    title: "Docs Search",
    tier: "auto_gen",
    confidence: 0.86,
    installCount: 412,
    lastParsedAt: "2026-05-29T14:25:00.000Z",
    status: "active",
    currentVersion: 2,
  },
  {
    serverId: "33333333-3333-4333-8333-333333333333",
    url: "https://shop.example.net",
    title: "Shop Catalog",
    tier: "auto_gen",
    confidence: 0.72,
    installCount: 87,
    lastParsedAt: "2026-05-28T22:15:00.000Z",
    status: "degraded",
    currentVersion: 3,
  },
  {
    serverId: "44444444-4444-4444-8444-444444444444",
    url: "https://status.example.org",
    title: "Status Page",
    tier: "auto_gen",
    confidence: 0.43,
    installCount: 19,
    lastParsedAt: "2026-05-27T09:00:00.000Z",
    status: "broken",
    currentVersion: 1,
  },
];

export const sampleVersions: ServerVersion[] = sampleRegistry.map((entry) => ({
  serverId: entry.serverId,
  version: entry.currentVersion,
  artifactUrl: `file:///tmp/mcp-sample-artifacts/${entry.serverId}/${entry.currentVersion}`,
  toolCount: Math.max(1, Math.round(entry.confidence * 4)),
  createdAt: entry.lastParsedAt,
  createdBy: entry.tier === "curated" ? "community" : "auto",
}));
