import {
  DOCS_TRY_LIMITS,
  DOCS_TRY_METHODS,
  type DocsTryRequest,
} from "@doxahq/contracts/docs-try";
import { z } from "zod";

const namedValue = z.tuple([
  z.string().min(1).max(256),
  z.string().max(DOCS_TRY_LIMITS.headerBytes),
]);

/**
 * SECURITY REGRESSION GUARDRAIL (SEC-010): strict, so a request that names a
 * `url` or a `host` is refused and never reaches `fetch`.
 */
export const tryRequestSchema = z
  .object({
    v: z.literal(1),
    targetId: z.string().min(1).max(128),
    method: z.enum(DOCS_TRY_METHODS),
    path: z.string().min(1).max(4096),
    query: z.array(namedValue).max(100).default([]),
    headers: z.array(namedValue).max(DOCS_TRY_LIMITS.headerCount).default([]),
    cookies: z.array(namedValue).max(DOCS_TRY_LIMITS.headerCount).default([]),
    body: z
      .object({ encoding: z.literal("utf8"), data: z.string() })
      .strict()
      .optional(),
  })
  .strict()
  .refine((request) => !request.body || !["GET", "HEAD"].includes(request.method));

/** JSON writes one control byte as `\\u0000`, the most that an escape can grow. */
const MAX_JSON_ESCAPE_GROWTH = 6;
/** Room for the method, the path, the query and the headers. */
const ENVELOPE_OVERHEAD_BYTES = 64 * 1024;
/** A body at the limit must fit in any encoding. `body_too_large` then checks its real size. */
const MAX_ENVELOPE_BYTES =
  DOCS_TRY_LIMITS.requestBytes * MAX_JSON_ESCAPE_GROWTH + ENVELOPE_OVERHEAD_BYTES;

export type ReadTryRequestResult =
  | { ok: true; request: DocsTryRequest }
  | { ok: false; code: "invalid_request" | "body_too_large" };

export async function readTryRequest(
  body: ReadableStream<Uint8Array> | null,
): Promise<ReadTryRequestResult> {
  if (!body) return { ok: false, code: "invalid_request" };
  const text = await readBoundedText(body, MAX_ENVELOPE_BYTES);
  if (text === null) return { ok: false, code: "body_too_large" };

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_request" };
  }
  const parsed = tryRequestSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: "invalid_request" };

  const request = parsed.data as DocsTryRequest;
  const bodyBytes = request.body
    ? new TextEncoder().encode(request.body.data).byteLength
    : 0;
  if (bodyBytes > DOCS_TRY_LIMITS.requestBytes) {
    return { ok: false, code: "body_too_large" };
  }
  return { ok: true, request };
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}
