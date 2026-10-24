/**
 * Core Agent Library - Provider errors
 * Turns a TanStack RUN_ERROR chunk into an error message that keeps the
 * upstream provider's reason, which OpenRouter sends only in the raw event.
 */

const MAX_REASON_CHARS = 500;
const FALLBACK_MESSAGE = "Provider stream failed";

interface RunErrorChunk {
  message?: unknown;
  code?: unknown;
  error?: { message?: unknown; code?: unknown };
  rawEvent?: unknown;
}

interface ProviderErrorDetail {
  providerName?: string;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Reads `{ error: { message } }` or `{ message }` from an upstream error body. */
function messageFromBody(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const nested = isRecord(body.error) ? nonEmptyString(body.error.message) : undefined;
  return nested ?? nonEmptyString(body.message);
}

function reasonFromRaw(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    return messageFromBody(parseJson(raw)) ?? nonEmptyString(raw);
  }
  return messageFromBody(raw) ?? (isRecord(raw) ? JSON.stringify(raw) : undefined);
}

function truncate(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}...` : text;
}

/**
 * The raw event is either OpenRouter's error object (`{ code, message, metadata }`)
 * or its metadata alone (`{ provider_name, raw }`).
 */
function providerErrorDetail(rawEvent: unknown, message: string): ProviderErrorDetail {
  if (!isRecord(rawEvent)) return {};
  const metadata = isRecord(rawEvent.metadata) ? rawEvent.metadata : rawEvent;
  const reason = reasonFromRaw(metadata.raw) ?? messageFromBody(rawEvent);
  return {
    providerName: nonEmptyString(metadata.provider_name),
    reason: reason && reason !== message ? truncate(reason) : undefined,
  };
}

/**
 * The finish reason that a RUN_ERROR stands for, when it is no failure.
 * Anthropic reports a response that stopped at the token limit as an error
 * with code `max_tokens`, where OpenRouter finishes it with `length`. Both
 * read as `length`, so the text so far is kept and the caller can retry.
 */
export function runErrorFinishReason(chunk: RunErrorChunk): "length" | null {
  const code = nonEmptyString(chunk.code) ?? nonEmptyString(chunk.error?.code);
  return code === "max_tokens" ? "length" : null;
}

/** Builds `message (code 400; anthropic: reason)`, leaving out the parts that are missing. */
export function runErrorMessage(chunk: RunErrorChunk): string {
  const message = nonEmptyString(chunk.message) ??
    nonEmptyString(chunk.error?.message) ??
    FALLBACK_MESSAGE;
  const code = nonEmptyString(chunk.code) ?? nonEmptyString(chunk.error?.code);
  const { providerName, reason } = providerErrorDetail(chunk.rawEvent, message);

  const details = [
    code ? `code ${code}` : undefined,
    reason ? (providerName ? `${providerName}: ${reason}` : reason) : providerName,
  ].filter((detail): detail is string => detail !== undefined);

  return details.length > 0 ? `${message} (${details.join("; ")})` : message;
}
