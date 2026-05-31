import { NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { fetchRegistry } from "@mcp/solana";

export const dynamic = "force-dynamic";

/**
 * GET /api/registry/onchain
 * Returns all MCP server records from the Solana on-chain registry.
 * SOLANA_RPC_URL env selects the chain (default: devnet).
 */
export async function GET(): Promise<Response> {
  const rpc = process.env["SOLANA_RPC_URL"] ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");

  try {
    const entries = await fetchRegistry(connection);
    return NextResponse.json(entries);
  } catch (err) {
    console.error("[onchain-registry] fetch failed:", err);
    return NextResponse.json(
      { error: "Failed to fetch on-chain registry", detail: String(err) },
      { status: 503 },
    );
  }
}
