import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  DISCRIMINANT,
  RECORD_SIZE,
  decodeServerRecord,
  encodeRegisterArgs,
  encodeUpdateArgs,
  toolSignature,
} from "./layout.js";

/** Public program ID of the on-chain server-registry program. */
export const PROGRAM_ID = new PublicKey("B6xe3XtwyokW7Nsud63otwagnJS4GMkAutWXwftMtCKh");

/** An entry as returned by fetchRegistry. */
export interface SolanaRegistryEntry {
  serverId: string;
  url: string;
  title: string;
  toolSig: string;
  /** 0-1 float, derived from the on-chain 0-100 integer. */
  confidence: number;
  toolCount: number;
  version: number;
  updatedAt: Date;
  /** Base58 address of the PDA account — use for Solana Explorer links. */
  pdaAddress: string;
}

/**
 * Derive the PDA for a given serverId.
 * We use the first 32 characters of the UUID (which is 36 chars) as the seed —
 * Solana seeds are capped at 32 bytes, and UUID first-32 is still unique.
 */
export function serverPda(serverId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("server"), Buffer.from(serverId.slice(0, 32), "ascii")],
    PROGRAM_ID,
  );
}

/**
 * Register or update a server in the on-chain registry.
 * Fire-and-forget safe: resolves to the tx signature on success, throws on failure.
 */
export async function publishServer(
  connection: Connection,
  authority: Keypair,
  entry: {
    serverId: string;
    url: string;
    title: string;
    toolNames: string[];
    confidence: number; // 0-1 float
  },
): Promise<string> {
  const [pda] = serverPda(entry.serverId);
  const existing = await connection.getAccountInfo(pda);
  const sig = toolSignature(entry.toolNames);
  const confidenceInt = Math.round(Math.min(1, Math.max(0, entry.confidence)) * 100);
  const now = Math.floor(Date.now() / 1000);

  const tx = new Transaction();
  if (existing) {
    tx.add(
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: pda, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([Buffer.from([0x01]), encodeUpdateArgs(sig, confidenceInt, entry.toolNames.length, now)]),
      }),
    );
  } else {
    tx.add(
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: pda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([
          Buffer.from([0x00]),
          encodeRegisterArgs(entry.serverId, entry.url, entry.title, sig, confidenceInt, entry.toolNames.length, now),
        ]),
      }),
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = authority.publicKey;
  tx.sign(authority);

  return connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
}

/**
 * Fetch all server records from the on-chain registry.
 * Filters to only accounts with the correct discriminant owned by this program.
 */
export async function fetchRegistry(connection: Connection): Promise<SolanaRegistryEntry[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: RECORD_SIZE }],
    encoding: "base64",
  });

  const results: SolanaRegistryEntry[] = [];
  for (const { pubkey, account } of accounts) {
    // account.data is either a [base64string, "base64"] tuple or a Buffer depending on encoding.
    const rawData = Array.isArray(account.data) ? account.data[0] : account.data;
    const data = typeof rawData === "string"
      ? Buffer.from(rawData, "base64")
      : Buffer.from(rawData as Uint8Array);
    const record = decodeServerRecord(data);
    if (!record) continue;
    results.push({
      serverId: record.serverId,
      url: record.url,
      title: record.title,
      toolSig: record.toolSig,
      confidence: record.confidence / 100,
      toolCount: record.toolCount,
      version: record.version,
      updatedAt: record.updatedAt,
      pdaAddress: pubkey.toBase58(),
    });
  }
  return results;
}

/**
 * Fetch a single server record by serverId.
 * Returns null if the account doesn't exist.
 */
export async function fetchServer(
  connection: Connection,
  serverId: string,
): Promise<SolanaRegistryEntry | null> {
  const [pda] = serverPda(serverId);
  const account = await connection.getAccountInfo(pda);
  if (!account) return null;
  const record = decodeServerRecord(Buffer.from(account.data));
  if (!record) return null;
  return {
    serverId: record.serverId,
    url: record.url,
    title: record.title,
    toolSig: record.toolSig,
    confidence: record.confidence / 100,
    toolCount: record.toolCount,
    version: record.version,
    updatedAt: record.updatedAt,
    pdaAddress: pda.toBase58(),
  };
}

export { toolSignature };
