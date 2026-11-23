// Bounded downloads: a hard byte cap and a timeout, so a huge or stalled
// file can never exhaust memory or hang a handler.

export class DownloadError extends Error {
  readonly kind: 'too_large' | 'http' | 'network';
  constructor(kind: 'too_large' | 'http' | 'network', message: string) {
    super(message);
    this.name = 'DownloadError';
    this.kind = kind;
  }
}

export async function downloadLimited(
  url: string,
  maxBytes: number,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
  } catch (error) {
    throw new DownloadError('network', error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new DownloadError('http', `HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new DownloadError('too_large', `declared ${declared} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new DownloadError('too_large', `more than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    throw new DownloadError('network', error instanceof Error ? error.message : String(error));
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
