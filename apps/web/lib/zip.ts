const encoder = new TextEncoder();

function toDosTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const u16 = (value: number) => Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
const u32 = (value: number) => Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);

function join(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function normalizePath(path: string) {
  return String(path || "file").replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean).join("/");
}

function fileEntry(path: string, content: string, stamp: { time: number; date: number }) {
  const name = encoder.encode(normalizePath(path));
  const data = encoder.encode(String(content ?? ""));
  const checksum = crc32(data);
  const localHeader = join([
    u32(0x04034b50), u16(20), u16(0), u16(0), u16(stamp.time), u16(stamp.date), u32(checksum),
    u32(data.length), u32(data.length), u16(name.length), u16(0), name,
  ]);
  const centralHeader = (offset: number) =>
    join([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(stamp.time), u16(stamp.date), u32(checksum),
      u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]);
  return { localHeader, data, centralHeader };
}

export function buildZip(entries: { path: string; content: string }[], root = "mcp-server") {
  const stamp = toDosTime(new Date());
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const record = fileEntry(`${normalizePath(root)}/${normalizePath(entry.path)}`, entry.content, stamp);
    locals.push(record.localHeader, record.data);
    centrals.push(record.centralHeader(offset));
    offset += record.localHeader.length + record.data.length;
  }
  const localBytes = join(locals);
  const centralBytes = join(centrals);
  return join([
    localBytes,
    centralBytes,
    join([u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length), u32(centralBytes.length), u32(localBytes.length), u16(0)]),
  ]);
}
