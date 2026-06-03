const decoder = new TextDecoder();

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

export async function readJsonWithLimit(req: Request, maxBytes: number): Promise<JsonBodyResult> {
  const contentLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, status: 413, error: `request body too large; max ${maxBytes} bytes` };
  }

  const reader = req.body?.getReader();
  if (!reader) return { ok: false, status: 400, error: "request body required" };

  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413, error: `request body too large; max ${maxBytes} bytes` };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, value: JSON.parse(decoder.decode(bytes)) };
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
}
