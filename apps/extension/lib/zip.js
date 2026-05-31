const encoder = new TextEncoder();

function toDosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function join(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function normalizePath(path) {
  return String(path || "file")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function fileEntry(path, content, stamp) {
  const name = encoder.encode(normalizePath(path));
  const data = encoder.encode(String(content ?? ""));
  const checksum = crc32(data);

  const localHeader = join([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(stamp.time),
    u16(stamp.date),
    u32(checksum),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    name,
  ]);

  const centralHeader = (offset) =>
    join([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(stamp.time),
      u16(stamp.date),
      u32(checksum),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);

  return { localHeader, data, centralHeader };
}

export function buildZip(entries, root = "mcp-artifact") {
  const stamp = toDosTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries || []) {
    const record = fileEntry(`${normalizePath(root)}/${normalizePath(entry.path)}`, entry.content, stamp);
    locals.push(record.localHeader, record.data);
    const localSize = record.localHeader.length + record.data.length;
    centrals.push(record.centralHeader(offset));
    offset += localSize;
  }

  const localBytes = join(locals);
  const centralBytes = join(centrals);
  const end = join([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(centrals.length),
    u16(centrals.length),
    u32(centralBytes.length),
    u32(localBytes.length),
    u16(0),
  ]);

  return join([localBytes, centralBytes, end]);
}

export function zipBlob(entries, root) {
  return new Blob([buildZip(entries, root)], { type: "application/zip" });
}
