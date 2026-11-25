export type Fetcher = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export interface PublicResponse {
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

export const BRANDING_USER_AGENT = "Mozilla/5.0 (compatible; Doxabot/1.0)";

const MAX_REDIRECTS = 4;

/**
 * Hosts that a repository homepage may name but that this step never reads.
 * Workers already refuse private addresses; this also keeps out IP literals
 * and local names, so a redirect cannot point the step at them.
 */
export function isFetchableUrl(value: string | URL): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "80" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".")) return false;
  if (/^\d+(?:\.\d+){3}$/.test(host) || host.startsWith("[")) return false;
  if (/(?:^|\.)(?:localhost|local|internal|lan|home|arpa|test|invalid)$/.test(host)) return false;
  return true;
}

/**
 * Reads a public URL with a size cap, a deadline, and manual redirects that
 * pass the same host checks. Returns null on any failure.
 */
export async function fetchPublic(
  fetcher: Fetcher,
  input: string,
  options: { maxBytes: number; timeoutMs: number; accept?: string },
): Promise<PublicResponse | null> {
  let url = input;
  const deadline = AbortSignal.timeout(options.timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isFetchableUrl(url)) return null;
      const response = await fetcher(url, {
        redirect: "manual",
        signal: deadline,
        headers: {
          "user-agent": BRANDING_USER_AGENT,
          accept: options.accept ?? "*/*",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) return null;
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > options.maxBytes) {
        await response.body.cancel().catch(() => undefined);
        return null;
      }
      const bytes = await readCapped(response.body, options.maxBytes);
      if (!bytes) return null;
      return {
        url,
        contentType: response.headers.get("content-type") ?? "",
        bytes,
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
