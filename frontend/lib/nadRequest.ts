/** Enforce the actual streamed body size; Content-Length alone is not a limit. */
export class NadRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export async function readNadJson(request: Request, maxBytes: number): Promise<unknown> {
  const advertised = request.headers.get('content-length');
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) {
    throw new NadRequestError(413, 'Request too large');
  }
  if (!request.body) throw new NadRequestError(400, 'JSON body required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new NadRequestError(413, 'Request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { throw new NadRequestError(400, 'Invalid JSON body'); }
}
