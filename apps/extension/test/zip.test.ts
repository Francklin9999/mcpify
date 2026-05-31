import { test } from "node:test";
import assert from "node:assert/strict";

import { buildZip } from "../lib/zip.js";

function readU16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

test("buildZip creates a valid store-only archive with the generated files", () => {
  const zip = buildZip(
    [
      { path: "server.ts", content: "export const ok = true;\n" },
      { path: "claude_desktop_config.json", content: '{"mcpServers":{}}' },
    ],
    "amazon-tools-v3",
  );

  assert.equal(readU32(zip, 0) >>> 0, 0x04034b50);

  const eocd = zip.length - 22;
  assert.equal(readU32(zip, eocd) >>> 0, 0x06054b50);
  assert.equal(readU16(zip, eocd + 8), 2, "two central directory records");
  assert.equal(readU16(zip, eocd + 10), 2, "two total records");

  const text = new TextDecoder().decode(zip);
  assert.match(text, /amazon-tools-v3\/server\.ts/);
  assert.match(text, /amazon-tools-v3\/claude_desktop_config\.json/);
  assert.match(text, /export const ok = true;/);
  assert.match(text, /"mcpServers"/);
});
