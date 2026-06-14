import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const PRIVATE_HOST_OVERRIDE = "FORGE_ALLOW_PRIVATE_HOSTS";

function envInt(key: string, fallback: number, min = 1): number {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.floor(raw));
}

function cleanHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function ipv4ToNumber(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    out = (out << 8) + n;
  }
  return out >>> 0;
}

function inRange(value: number, base: string, maskBits: number): boolean {
  const baseNum = ipv4ToNumber(base);
  if (baseNum == null) return false;
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (value & mask) === (baseNum & mask);
}

export function isPrivateOrReservedIp(address: string): boolean {
  const host = cleanHostname(address);
  if (isIP(host) === 4) {
    const n = ipv4ToNumber(host);
    if (n == null) return true;
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, bits]) => inRange(n, base as string, bits as number));
  }

  if (isIP(host) === 6) {
    const h = host.toLowerCase();
    if (h === "::" || h === "::1") return true;
    if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:") || h.startsWith("ff")) return true;
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateOrReservedIp(mapped[1]);
  }

  return false;
}

async function lookupWithTimeout(hostname: string): Promise<Array<{ address: string }>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const ms = envInt("FORGE_DNS_LOOKUP_TIMEOUT_MS", 5000, 100);
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("DNS lookup timed out")), ms);
  });
  try {
    return await Promise.race([lookup(hostname, { all: true, verbatim: true }).catch(() => []), timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function assertPublicHttpUrl(rawUrl: string, opts: { allowEnv?: string } = {}): Promise<URL> {
  if (process.env[opts.allowEnv ?? PRIVATE_HOST_OVERRIDE] === "1") {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
    return url;
  }

  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  const hostname = cleanHostname(url.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateOrReservedIp(hostname)) {
    throw new Error("refusing to fetch a private, loopback, reserved, or non-public URL");
  }

  const addresses = await lookupWithTimeout(hostname).catch(() => []);
  if (!addresses.length) throw new Error("refusing to fetch a hostname that does not resolve");
  if (addresses.some((entry) => isPrivateOrReservedIp(entry.address))) {
    throw new Error("refusing to fetch a hostname that resolves to a private, loopback, or reserved address");
  }
  return url;
}

export async function fetchPublicHttpUrl(
  rawUrl: string,
  init: RequestInit = {},
  opts: { allowEnv?: string; maxRedirects?: number } = {},
): Promise<Response> {
  let url = (await assertPublicHttpUrl(rawUrl, opts)).toString();
  let requestInit: RequestInit = { ...init, redirect: "manual" };
  const maxRedirects = opts.maxRedirects ?? 10;

  for (let redirects = 0; ; redirects++) {
    const res = await fetch(url, requestInit);
    if (res.status < 300 || res.status >= 400) return res;

    const location = res.headers.get("location");
    if (!location) return res;
    if (redirects >= maxRedirects) throw new Error(`too many redirects; max ${maxRedirects}`);

    const next = new URL(location, url).toString();
    await assertPublicHttpUrl(next, opts);
    await res.body?.cancel().catch(() => {});

    const method = String(requestInit.method || "GET").toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      const rest: RequestInit = { ...requestInit };
      delete rest.body;
      requestInit = { ...rest, method: "GET", redirect: "manual" };
    }
    url = next;
  }
}
