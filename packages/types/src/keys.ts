/**
 * Redis key patterns and R2 object-key layout (`02-data-model.md`). Centralized so every service builds
 * the same keys. `packages/db` owns Postgres; these non-Postgres keys live here in the contracts package.
 */

/** Redis keys (`02`). */
export const redisKeys = {
  /** Cached job status for GET /api/jobs/:id (minutes TTL). */
  job: (jobId: string): string => `job:${jobId}`,
  /** Latest DOM hash + small snapshot, for change detection (hours TTL). */
  dom: (serverId: string): string => `dom:${serverId}`,
  /** Per-host rate-limit sliding window. */
  rateLimit: (host: string): string => `rl:${host}`,
} as const;

/** R2 object keys (`02`). */
export const r2Keys = {
  /** Generated server artifact zip. */
  artifact: (serverId: string, version: number): string => `artifacts/${serverId}/${version}.zip`,
  /** Stored capture bundle — only persisted when legalMode permits (`04`). */
  bundle: (bundleId: string): string => `bundles/${bundleId}.json`,
} as const;
