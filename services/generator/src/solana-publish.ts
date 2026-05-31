/**
 * Best-effort Solana on-chain registry publication.
 * Called after successful generate/regenerate — never throws (failure is logged, not propagated).
 *
 * Env vars:
 *   SOLANA_RPC_URL              — Solana RPC endpoint (defaults to devnet)
 *   SOLANA_REGISTRY_KEYPAIR     — JSON byte-array or file path to the authority keypair
 */
import type { RegistryEntry, ToolDefinition } from "@mcp/types";
import { makeConnection, loadKeypair, publishServer } from "@mcp/solana";

export async function publishToSolana(entry: RegistryEntry, tools: ToolDefinition[]): Promise<void> {
  const keypair = loadKeypair();
  if (!keypair) return; // not configured — skip silently

  const connection = makeConnection();
  const toolNames = tools.map((t) => t.name);

  try {
    const txSig = await publishServer(connection, keypair, {
      serverId: entry.serverId,
      url: entry.url,
      title: entry.title,
      toolNames,
      confidence: entry.confidence,
    });
    console.log(
      `[solana] published ${entry.serverId} → ${entry.url} (${toolNames.length} tools) tx=${txSig}`,
    );
  } catch (err) {
    // Best-effort: log and continue — chain failure must not fail generation.
    console.warn(`[solana] publish failed for ${entry.serverId}:`, err instanceof Error ? err.message : String(err));
  }
}
