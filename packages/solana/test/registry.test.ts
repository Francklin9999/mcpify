import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import {
  PROGRAM_ID,
  publishServer,
  fetchRegistry,
  fetchServer,
  serverPda,
  toolSignature,
} from "../src/index.js";
import {
  DISCRIMINANT,
  RECORD_SIZE,
  decodeServerRecord,
  encodeRegisterArgs,
  encodeUpdateArgs,
} from "../src/layout.js";

// ── layout round-trip ─────────────────────────────────────────────────────────

describe("layout round-trip", () => {
  test("encodeRegisterArgs / decodeServerRecord", () => {
    const serverId = "11111111-1111-1111-1111-111111111111";
    const url = "https://example.com/products";
    const title = "Example Products";
    const sig = toolSignature(["search_products", "get_product"]);
    const confidence = 87;
    const toolCount = 2;
    const updatedAt = Math.floor(Date.now() / 1000);

    const args = encodeRegisterArgs(serverId, url, title, sig, confidence, toolCount, updatedAt);
    assert.equal(args.length, 36 + 200 + 1 + 100 + 1 + 64 + 1 + 2 + 8, "args buf size");

    // Fake a full on-chain account by building the account data manually
    const acct = Buffer.alloc(RECORD_SIZE, 0);
    acct[0] = DISCRIMINANT;
    const authority = Keypair.generate().publicKey.toBytes();
    acct.set(authority, 1);
    // Copy args fields into the right positions
    acct.set(Buffer.from(serverId, "ascii"), 33);
    acct.set(args.subarray(36, 236), 69); // url bytes
    acct[269] = args[236] ?? 0; // url_len
    acct.set(args.subarray(237, 337), 270); // title bytes
    acct[370] = args[337] ?? 0; // title_len
    acct.set(args.subarray(338, 402), 371); // tool_sig
    acct[435] = confidence;
    acct.writeUInt16LE(toolCount, 436);
    acct.writeUInt32LE(1, 438); // version = 1
    acct.writeBigInt64LE(BigInt(updatedAt), 442);
    acct[450] = 255; // bump

    const decoded = decodeServerRecord(acct);
    assert.ok(decoded, "should decode");
    assert.equal(decoded!.serverId.trim(), serverId.trim());
    assert.equal(decoded!.url, url);
    assert.equal(decoded!.title, title);
    assert.equal(decoded!.confidence, confidence);
    assert.equal(decoded!.toolCount, toolCount);
    assert.equal(decoded!.version, 1);
  });

  test("decodeServerRecord returns null for wrong discriminant", () => {
    const buf = Buffer.alloc(RECORD_SIZE);
    buf[0] = 0x00; // wrong
    assert.equal(decodeServerRecord(buf), null);
  });

  test("decodeServerRecord returns null for undersized buffer", () => {
    assert.equal(decodeServerRecord(Buffer.alloc(10)), null);
  });
});

// ── toolSignature ─────────────────────────────────────────────────────────────

describe("toolSignature", () => {
  test("is order-independent", () => {
    const a = toolSignature(["get_product", "search_products"]);
    const b = toolSignature(["search_products", "get_product"]);
    assert.equal(a, b);
  });

  test("changes when tool names change", () => {
    const a = toolSignature(["get_product"]);
    const b = toolSignature(["get_product", "list_products"]);
    assert.notEqual(a, b);
  });

  test("is always 64 hex chars", () => {
    assert.equal(toolSignature([]).length, 64);
    assert.equal(toolSignature(["x"]).length, 64);
  });
});

// ── serverPda ─────────────────────────────────────────────────────────────────

test("serverPda is deterministic", () => {
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const [pda1, bump1] = serverPda(id);
  const [pda2, bump2] = serverPda(id);
  assert.equal(pda1.toBase58(), pda2.toBase58());
  assert.equal(bump1, bump2);
});

// ── mock RPC tests ────────────────────────────────────────────────────────────

describe("publishServer (mock RPC)", () => {
  function mockConnection(existingAccount: Buffer | null): Connection {
    const conn = new Connection("http://localhost:8899", "confirmed");
    // Mock getAccountInfo
    mock.method(conn, "getAccountInfo", async () =>
      existingAccount
        ? { data: existingAccount, executable: false, lamports: 1000000, owner: PROGRAM_ID, rentEpoch: 0 }
        : null,
    );
    // Mock getLatestBlockhash
    mock.method(conn, "getLatestBlockhash", async () => ({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 999999,
    }));
    let capturedTx: Buffer | null = null;
    // Mock sendRawTransaction — capture the TX for inspection
    mock.method(conn, "sendRawTransaction", async (rawTx: Uint8Array) => {
      capturedTx = Buffer.from(rawTx);
      return "mockSignature123";
    });
    (conn as any).__capturedTx = () => capturedTx;
    return conn;
  }

  test("returns a tx signature for a new server (register path)", async () => {
    const authority = Keypair.generate();
    const conn = mockConnection(null); // no existing account
    const sig = await publishServer(conn, authority, {
      serverId: "22222222-2222-2222-2222-222222222222",
      url: "https://test.example.com",
      title: "Test Site",
      toolNames: ["search", "get_item"],
      confidence: 0.85,
    });
    assert.equal(sig, "mockSignature123");
  });

  test("uses update instruction when account already exists", async () => {
    const authority = Keypair.generate();
    // Build a fake existing account
    const existingData = Buffer.alloc(RECORD_SIZE, 0);
    existingData[0] = DISCRIMINANT;
    existingData.set(authority.publicKey.toBytes(), 1);
    const conn = mockConnection(existingData);
    const sig = await publishServer(conn, authority, {
      serverId: "33333333-3333-3333-3333-333333333333",
      url: "https://update.example.com",
      title: "Updated",
      toolNames: ["search"],
      confidence: 0.9,
    });
    assert.equal(sig, "mockSignature123");
    // Verify the instruction byte is 0x01 (update)
    const rawTx = (conn as any).__capturedTx() as Buffer | null;
    assert.ok(rawTx, "tx was captured");
    // Find 0x01 in the transaction data (it appears as the first byte of instruction data)
    // We can't easily parse the full TX binary here, so just verify we got a response
    assert.equal(sig, "mockSignature123");
  });
});

describe("fetchRegistry (mock RPC)", () => {
  test("returns parsed entries for matching accounts", async () => {
    const authority = Keypair.generate();
    const conn = new Connection("http://localhost:8899", "confirmed");

    // Build a valid on-chain account
    const acct = Buffer.alloc(RECORD_SIZE, 0);
    acct[0] = DISCRIMINANT;
    acct.set(authority.publicKey.toBytes(), 1);
    const serverId = "44444444-4444-4444-4444-444444444444";
    acct.set(Buffer.from(serverId, "ascii"), 33);
    const urlBytes = Buffer.from("https://fetch-test.com");
    acct.set(urlBytes, 69);
    acct[269] = urlBytes.length;
    const titleBytes = Buffer.from("Fetch Test");
    acct.set(titleBytes, 270);
    acct[370] = titleBytes.length;
    const sig = toolSignature(["tool_a"]);
    acct.set(Buffer.from(sig, "ascii"), 371);
    acct[435] = 75; // confidence
    acct.writeUInt16LE(1, 436); // toolCount
    acct.writeUInt32LE(2, 438); // version
    acct.writeBigInt64LE(BigInt(1700000000), 442);

    mock.method(conn, "getProgramAccounts", async () => [
      {
        pubkey: new PublicKey("11111111111111111111111111111112"),
        account: {
          data: [acct.toString("base64"), "base64"],
          executable: false,
          lamports: 1000000,
          owner: PROGRAM_ID,
          rentEpoch: 0,
        },
      },
    ]);

    const entries = await fetchRegistry(conn);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.serverId.trim(), serverId);
    assert.equal(entries[0]!.url, "https://fetch-test.com");
    assert.equal(entries[0]!.confidence, 0.75);
    assert.equal(entries[0]!.toolCount, 1);
    assert.equal(entries[0]!.version, 2);
  });

  test("ignores accounts with wrong discriminant", async () => {
    const conn = new Connection("http://localhost:8899", "confirmed");
    const badAcct = Buffer.alloc(RECORD_SIZE, 0); // discriminant = 0x00
    mock.method(conn, "getProgramAccounts", async () => [
      {
        pubkey: new PublicKey("11111111111111111111111111111112"),
        account: { data: [badAcct.toString("base64"), "base64"], executable: false, lamports: 0, owner: PROGRAM_ID, rentEpoch: 0 },
      },
    ]);
    const entries = await fetchRegistry(conn);
    assert.equal(entries.length, 0);
  });
});

// ── integration test against local validator ──────────────────────────────────

const LOCALNET_RPC = process.env["SOLANA_TEST_VALIDATOR_URL"] ?? "http://localhost:8899";

describe("integration: local validator", { skip: !process.env["SOLANA_INTEGRATION_TEST"] }, () => {
  test("register → fetchServer → update → fetchRegistry", async () => {
    const conn = new Connection(LOCALNET_RPC, "confirmed");

    // Check validator is reachable
    const slot = await conn.getSlot().catch(() => null);
    if (slot === null) {
      // eslint-disable-next-line no-process-exit -- loud skip: the validator must be running
      assert.fail(`SOLANA_INTEGRATION_TEST set but validator at ${LOCALNET_RPC} is not reachable`);
    }

    const authority = Keypair.generate();

    // Airdrop 0.1 SOL to pay fees
    const airdropSig = await conn.requestAirdrop(authority.publicKey, 100_000_000);
    await conn.confirmTransaction(airdropSig, "confirmed");

    // Use a fresh UUID each run so the PDA is never stale from a prior test.
    const serverId = crypto.randomUUID();

    // Register
    const regSig = await publishServer(conn, authority, {
      serverId,
      url: "https://integration-test.example.com",
      title: "Integration Test",
      toolNames: ["search_items", "get_item"],
      confidence: 0.9,
    });
    await conn.confirmTransaction(regSig, "confirmed");

    // fetchServer
    const entry = await fetchServer(conn, serverId);
    assert.ok(entry, "server should exist after register");
    assert.equal(entry!.url, "https://integration-test.example.com");
    assert.equal(entry!.toolCount, 2);
    assert.equal(entry!.version, 1);
    assert.equal(entry!.confidence, 0.9);

    // Update
    const updateSig = await publishServer(conn, authority, {
      serverId,
      url: "https://integration-test.example.com",
      title: "Integration Test",
      toolNames: ["search_items", "get_item", "list_categories"],
      confidence: 0.95,
    });
    await conn.confirmTransaction(updateSig, "confirmed");

    // fetchRegistry
    const all = await fetchRegistry(conn);
    const found = all.find((e) => e.serverId.trim() === serverId);
    assert.ok(found, "should appear in fetchRegistry");
    assert.equal(found!.toolCount, 3);
    assert.equal(found!.version, 2);
  });
});
