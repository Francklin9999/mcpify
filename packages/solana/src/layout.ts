import { createHash } from "crypto";

// ── On-chain account layout (must match programs/server-registry/src/lib.rs) ──
//
//  [0]        discriminant  u8      magic = 0xAB
//  [1..33]    authority     [u8;32]
//  [33..69]   server_id     [u8;36] UUID ASCII
//  [69..269]  url           [u8;200] UTF-8 zero-padded
//  [269]      url_len       u8
//  [270..370] title         [u8;100] UTF-8 zero-padded
//  [370]      title_len     u8
//  [371..435] tool_sig      [u8;64] sha256 hex
//  [435]      confidence    u8      0-100
//  [436..438] tool_count    u16 LE
//  [438..442] version       u32 LE
//  [442..450] updated_at    i64 LE  unix seconds
//  [450]      bump          u8
//
// Total: 451 bytes

export const RECORD_SIZE = 451;
export const DISCRIMINANT = 0xab;

export interface ServerRecord {
  authority: Uint8Array; // 32 bytes
  serverId: string;      // UUID
  url: string;
  title: string;
  toolSig: string;       // sha256 hex of sorted tool names
  confidence: number;    // 0-100 integer
  toolCount: number;
  version: number;
  updatedAt: Date;
  bump: number;
}

export function encodeRegisterArgs(
  serverId: string,
  url: string,
  title: string,
  toolSig: string,
  confidence: number,
  toolCount: number,
  updatedAt: number,
): Buffer {
  const urlBytes = Buffer.from(url, "utf8").subarray(0, 200);
  const titleBytes = Buffer.from(title, "utf8").subarray(0, 100);
  const toolSigBytes = Buffer.from(toolSig.padEnd(64, "0").slice(0, 64), "ascii");
  const serverIdBytes = Buffer.from(serverId.padEnd(36, " ").slice(0, 36), "ascii");

  // Layout: server_id[36] + url[200] + url_len[1] + title[100] + title_len[1] + tool_sig[64] + confidence[1] + tool_count[2] + updated_at[8]
  const buf = Buffer.alloc(36 + 200 + 1 + 100 + 1 + 64 + 1 + 2 + 8);
  let offset = 0;

  buf.set(serverIdBytes, offset); offset += 36;

  const urlPad = Buffer.alloc(200);
  urlPad.set(urlBytes);
  buf.set(urlPad, offset); offset += 200;
  buf.writeUInt8(urlBytes.length, offset++);

  const titlePad = Buffer.alloc(100);
  titlePad.set(titleBytes);
  buf.set(titlePad, offset); offset += 100;
  buf.writeUInt8(titleBytes.length, offset++);

  buf.set(toolSigBytes, offset); offset += 64;
  buf.writeUInt8(confidence, offset++);
  buf.writeUInt16LE(toolCount, offset); offset += 2;
  buf.writeBigInt64LE(BigInt(updatedAt), offset);

  return buf;
}

export function encodeUpdateArgs(
  toolSig: string,
  confidence: number,
  toolCount: number,
  updatedAt: number,
): Buffer {
  const toolSigBytes = Buffer.from(toolSig.padEnd(64, "0").slice(0, 64), "ascii");
  // Layout: tool_sig[64] + confidence[1] + tool_count[2] + updated_at[8]
  const buf = Buffer.alloc(75);
  buf.set(toolSigBytes, 0);
  buf.writeUInt8(confidence, 64);
  buf.writeUInt16LE(toolCount, 65);
  buf.writeBigInt64LE(BigInt(updatedAt), 67);
  return buf;
}

export function decodeServerRecord(data: Buffer): ServerRecord | null {
  if (data.length < RECORD_SIZE || data[0] !== DISCRIMINANT) return null;
  return {
    authority: data.subarray(1, 33),
    serverId: data.subarray(33, 69).toString("ascii").trimEnd(),
    url: data.subarray(69, 69 + (data[269] ?? 0)).toString("utf8"),
    title: data.subarray(270, 270 + (data[370] ?? 0)).toString("utf8"),
    toolSig: data.subarray(371, 435).toString("ascii"),
    confidence: data[435] ?? 0,
    toolCount: data.readUInt16LE(436),
    version: data.readUInt32LE(438),
    updatedAt: new Date(Number(data.readBigInt64LE(442)) * 1000),
    bump: data[450] ?? 0,
  };
}

/** sha256 hex of sorted, comma-joined tool names — deterministic tool set fingerprint. */
export function toolSignature(toolNames: string[]): string {
  return createHash("sha256")
    .update([...toolNames].sort().join(","))
    .digest("hex")
    .slice(0, 64);
}
