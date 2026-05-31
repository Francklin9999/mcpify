import { z } from "zod";
import { Confidence, IsoDateTime } from "./common.js";

/** curated = hand-verified (confidence always >= 0.95). auto_gen = generated + community-verified. */
export const ServerTier = z.enum(["curated", "auto_gen"]);
export type ServerTier = z.infer<typeof ServerTier>;

export const ServerStatus = z.enum(["active", "degraded", "broken", "regenerating"]);
export type ServerStatus = z.infer<typeof ServerStatus>;

/** RegistryEntry — read by web + monitor, written by generator (`01 §5`, `02-data-model.md`). */
export const RegistryEntry = z.object({
  serverId: z.string().uuid(),
  url: z.string().url(),
  title: z.string(),
  tier: ServerTier,
  confidence: Confidence,
  installCount: z.number().int().nonnegative(),
  lastParsedAt: IsoDateTime,
  status: ServerStatus,
  currentVersion: z.number().int().positive(),
});
export type RegistryEntry = z.infer<typeof RegistryEntry>;

/** `createdBy`: 'auto' | 'self_heal' | 'community' | a userId. */
export const ServerVersion = z.object({
  serverId: z.string().uuid(),
  version: z.number().int().positive(),
  artifactUrl: z.string().url(),
  toolCount: z.number().int().nonnegative(),
  createdAt: IsoDateTime,
  createdBy: z.string(),
});
export type ServerVersion = z.infer<typeof ServerVersion>;
