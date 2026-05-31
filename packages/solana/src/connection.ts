import { Connection, Keypair } from "@solana/web3.js";
import { readFileSync } from "fs";

/**
 * Build a Connection from env. Falls back to devnet when SOLANA_RPC_URL is unset.
 * Devnet = real chain (persists). Localnet (http://localhost:8899) = test validator.
 */
export function makeConnection(): Connection {
  const rpc = process.env["SOLANA_RPC_URL"] ?? "https://api.devnet.solana.com";
  return new Connection(rpc, "confirmed");
}

/**
 * Load the registry authority keypair from env.
 *
 * SOLANA_REGISTRY_KEYPAIR accepts either:
 *   - a JSON array of numbers (byte array): "[1,2,3,...]"
 *   - a base58 private key string (64 bytes encoded)
 *   - a file path to a keypair JSON file
 *
 * Returns null when the env var is not set (read-only mode is still possible).
 */
export function loadKeypair(): Keypair | null {
  const raw = process.env["SOLANA_REGISTRY_KEYPAIR"];
  if (!raw) return null;

  // File path
  if (raw.endsWith(".json") || raw.startsWith("/")) {
    try {
      const bytes = JSON.parse(readFileSync(raw, "utf8")) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(bytes));
    } catch {
      throw new Error(`SOLANA_REGISTRY_KEYPAIR: cannot read keypair file at ${raw}`);
    }
  }

  // JSON byte array
  if (raw.startsWith("[")) {
    try {
      const bytes = JSON.parse(raw) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(bytes));
    } catch {
      throw new Error("SOLANA_REGISTRY_KEYPAIR: invalid JSON byte array");
    }
  }

  throw new Error("SOLANA_REGISTRY_KEYPAIR: unrecognised format — expected JSON byte array '[1,2,...]' or a file path")
}
