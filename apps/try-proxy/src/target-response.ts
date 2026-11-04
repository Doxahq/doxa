import {
  DOCS_TRY_LIMITS,
  DOCS_TRY_PROBLEM_CONTENT_TYPE,
  DOCS_TRY_RESULT_HEADER,
  DOCS_TRY_TARGET_CHANGED_TITLE,
  encodeDocsTryResult,
  type DocsTryProblem,
  type DocsTryProblemCode,
  type DocsTryResult,
} from "@doxahq/contracts/docs-try";

const PROBLEM_TEXT: Record<DocsTryProblemCode, { status: number; title: string }> = {
  try_off: { status: 403, title: "This site does not send requests through Doxa." },
  not_same_origin: { status: 403, title: "This request did not come from this docs site." },
  target_blocked: { status: 403, title: "Doxa does not send requests to this host." },
  target_changed: { status: 409, title: DOCS_TRY_TARGET_CHANGED_TITLE },
  invalid_request: { status: 400, title: "This request does not have the expected form." },
  unsupported_media_type: { status: 415, title: "This request has the wrong content type." },
  path_refused: { status: 400, title: "Doxa does not send requests to this path." },
  header_refused: { status: 400, title: "Doxa does not send this header." },
  body_too_large: { status: 413, title: "This request is larger than the limit of 2 MB." },
  rate_limited: { status: 429, title: "Too many requests. Wait, then try again." },
  target_dns: { status: 502, title: "Doxa could not find this host on the public internet." },
  target_tls: { status: 502, title: "The API did not give a valid TLS certificate." },
  target_refused: { status: 502, title: "Doxa could not connect to the API." },
  target_timeout: { status: 504, title: "The API did not answer in time." },
};

export function tryProblem(
  code: DocsTryProblemCode,
  options: { retryAfter?: number; title?: string } = {},
): Response {
  const { status, title } = PROBLEM_TEXT[code];
  const body: DocsTryProblem = {
    code,
    title: options.title ?? title,
    ...(options.retryAfter ? { retryAfter: options.retryAfter } : {}),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": DOCS_TRY_PROBLEM_CONTENT_TYPE,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(options.retryAfter ? { "retry-after": String(options.retryAfter) } : {}),
    },
  });
}

const CLOUDFLARE_ERROR_STATUS = new Set([403, 409, 521, 522, 523, 524, 525, 526, 530]);
const CLOUDFLARE_ERROR_BODY = /^error code: (\d+)\s*$/;
const CLOUDFLARE_ERROR_MAX_BYTES = 64;
/** Cloudflare sends the whole error at once, so a body that waits is not one. */
const CLOUDFLARE_ERROR_WAIT_MS = 2_000;

const DEADLINE = Symbol("deadline");

type BodyRead = ReadableStreamReadResult<Uint8Array>;

/**
 * Reads the start of a body from the target, up to a size and a time. The
 * target controls the body, so this must not read all of it. Nothing is lost:
 * `rest` gives again each chunk that was read, then the remainder.
 */
async function peekBody(
  body: ReadableStream<Uint8Array>,
  limits: { maxBytes: number; waitMs: number },
): Promise<{ head: Uint8Array[]; size: number; ended: boolean; rest: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const reads: Promise<BodyRead>[] = [];
  const head: Uint8Array[] = [];
  let size = 0;
  let ended = false;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), limits.waitMs);
  });
  try {
    while (!ended && size <= limits.maxBytes) {
      const read = reader.read();
      reads.push(read);
      // `rest` reports a failed read. It can be unused, so mark it as handled.
      read.catch(() => undefined);
      const next = await Promise.race([read, deadline]);
      if (next === DEADLINE) break;
      if (next.done) {
        ended = true;
      } else {
        head.push(next.value);
        size += next.value.byteLength;
      }
    }
  } catch {
    // A body that fails is not a Cloudflare error. `rest` gives the failure on.
  } finally {
    clearTimeout(timer);
  }

  const rest = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await (reads.shift() ?? reader.read());
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason: unknown) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  return { head, size, ended, rest };
}

/**
 * Cloudflare answers a failed connection with a short plain text response, not
 * with an exception. `server: cloudflare` is on every response, so only the
 * status and the exact body can tell this apart from an answer of the API.
 * `body` is the body to use from now on, because the check reads its start.
 *
 * Measured with a spike on 2026-11-03: 530 + 1016 for a missing name and for a
 * name that resolves to a private address, 526 for a bad certificate.
 */
export async function classifyCloudflareFailure(
  answer: Response,
  waitMs: number = CLOUDFLARE_ERROR_WAIT_MS,
): Promise<{ failure: DocsTryProblemCode | null; body: ReadableStream<Uint8Array> | null }> {
  const contentType = answer.headers.get("content-type") ?? "";
  if (
    !answer.body ||
    !CLOUDFLARE_ERROR_STATUS.has(answer.status) ||
    !contentType.toLowerCase().startsWith("text/plain")
  ) {
    return { failure: null, body: answer.body };
  }
  const { head, size, ended, rest } = await peekBody(answer.body, {
    maxBytes: CLOUDFLARE_ERROR_MAX_BYTES,
    waitMs,
  });
  // Only a body that ended within the limit is the exact error text.
  const text = ended && size <= CLOUDFLARE_ERROR_MAX_BYTES ? decodeChunks(head) : "";
  const match = CLOUDFLARE_ERROR_BODY.exec(text);
  return { failure: match ? cloudflareProblem(match[1]) : null, body: rest };
}

function decodeChunks(chunks: readonly Uint8Array[]): string {
  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

function cloudflareProblem(code: string | undefined): DocsTryProblemCode {
  switch (code) {
    case "1016":
      return "target_dns";
    case "525":
    case "526":
      return "target_tls";
    case "524":
      return "target_timeout";
    default:
      return "target_refused";
  }
}

/**
 * The answer for the docs page. It drops every target header, so a target's
 * `Set-Cookie` or HTML has no effect on the docs origin. The page reads them as
 * text from the result header.
 */
export function toTryAnswer(input: {
  answer: Response;
  /** The body to send on. `classifyCloudflareFailure` gives it. */
  body: ReadableStream<Uint8Array> | null;
  requestUrl: URL;
  target: { origin: string; basePath: string };
  elapsedMs: number;
}): Response {
  const { answer, body, requestUrl, target, elapsedMs } = input;
  const redirect = readRedirect(answer, requestUrl, target);
  const result: DocsTryResult = {
    status: answer.status,
    statusText: answer.statusText === "<none>" ? "" : answer.statusText,
    elapsedMs,
    headers: [...answer.headers],
    headersTruncated: false,
    ...(redirect ? { redirect } : {}),
  };
  const eventStream = (answer.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("text/event-stream");

  // The limit covers the whole request, so the wait for the answer counts.
  const totalMs = eventStream ? DOCS_TRY_LIMITS.eventStreamTotalMs : DOCS_TRY_LIMITS.totalMs;

  return new Response(
    body
      ? limitBody(body, {
          maxBytes: DOCS_TRY_LIMITS.responseBytes,
          totalMs: Math.max(0, totalMs - elapsedMs),
        })
      : null,
    {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "no-store",
        [DOCS_TRY_RESULT_HEADER]: encodeWithinLimit(result),
      },
    },
  );
}

/** Drops headers from the end until the result fits in one response header. */
function encodeWithinLimit(result: DocsTryResult): string {
  let current = result;
  let encoded = encodeDocsTryResult(current);
  while (encoded.length > DOCS_TRY_LIMITS.resultHeaderBytes && current.headers.length > 0) {
    current = { ...current, headers: current.headers.slice(0, -1), headersTruncated: true };
    encoded = encodeDocsTryResult(current);
  }
  return encoded;
}

function readRedirect(
  answer: Response,
  requestUrl: URL,
  target: { origin: string; basePath: string },
): DocsTryResult["redirect"] {
  const location = answer.headers.get("location");
  if (!location || answer.status < 300 || answer.status >= 400) return undefined;
  let resolved: URL;
  try {
    resolved = new URL(location, requestUrl);
  } catch {
    return { location: location.slice(0, 2048), sameTarget: false };
  }
  return {
    location: resolved.toString().slice(0, 2048),
    sameTarget:
      resolved.origin === target.origin &&
      `${resolved.pathname}/`.startsWith(`${target.basePath}/`),
  };
}

/**
 * Passes the body on as it arrives, up to the limits. It then ends the stream
 * without an error, so the reader keeps what arrived. It is a byte stream,
 * because a Worker can send only a byte stream over a service binding.
 */
export function limitBody(
  body: ReadableStream<Uint8Array>,
  limits: { maxBytes: number; totalMs: number },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const deadlineAt = Date.now() + limits.totalMs;
  let sent = 0;

  return new ReadableStream({
    type: "bytes",
    async pull(controller: ReadableByteStreamController) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE), Math.max(0, deadlineAt - Date.now()));
      });
      const next = await Promise.race([reader.read(), deadline]);
      clearTimeout(timer);

      if (next === DEADLINE) {
        await reader.cancel();
        controller.close();
        return;
      }
      if (next.done) {
        controller.close();
        return;
      }
      const room = limits.maxBytes - sent;
      const chunk = next.value.byteLength > room ? next.value.slice(0, room) : next.value;
      sent += chunk.byteLength;
      if (chunk.byteLength > 0) controller.enqueue(chunk);
      if (sent >= limits.maxBytes) {
        await reader.cancel();
        controller.close();
      }
    },
    cancel(reason: unknown) {
      return reader.cancel(reason);
    },
  }) as ReadableStream<Uint8Array>;
}
