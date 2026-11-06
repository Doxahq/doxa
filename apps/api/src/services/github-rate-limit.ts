/** The part of a refusal body that can say "rate limit"; GitHub puts it in the first line. */
const REFUSAL_BODY_PREFIX_BYTES = 1_024;

/**
 * Whether a GitHub refusal is a rate limit, which passes, and not a refusal
 * for good. GitHub answers a rate limit with 403 too. A primary limit says so
 * in its headers. A secondary limit can come without them, and then its
 * message says "rate limit". Reads at most the start of the body.
 */
export async function isGitHubRateLimited(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  if (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0") {
    return true;
  }
  return /rate limit/i.test(await bodyPrefix(response, REFUSAL_BODY_PREFIX_BYTES));
}

/** At most `maxBytes` of a body, read without loading the rest. Empty when it does not arrive. */
async function bodyPrefix(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    return text.slice(0, maxBytes);
  } catch {
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
