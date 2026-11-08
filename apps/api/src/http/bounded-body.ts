export class RequestBodyTooLarge extends Error {}

export class RequestBodyTimeout extends Error {}

/** Content-Length is advisory. The stream limit also covers chunked uploads. */
export function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  return readBody(request, maxBytes, null);
}

/**
 * `readBoundedBody` with a deadline for the whole body: a client that sends
 * slowly gets `RequestBodyTimeout` instead of holding the request open.
 */
export function readBoundedBodyWithin(
  request: Request,
  maxBytes: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  return readBody(request, maxBytes, Date.now() + timeoutMs);
}

async function readBody(
  request: Request,
  maxBytes: number,
  deadlineMs: number | null,
): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new RequestBodyTooLarge();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await readBefore(reader, deadlineMs);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLarge();
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof RequestBodyTimeout) await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** One read, or `RequestBodyTimeout` when the deadline passes first. */
async function readBefore(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineMs: number | null,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (deadlineMs === null) return reader.read();
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new RequestBodyTimeout();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestBodyTimeout()), remaining);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The request with its body limited to `maxBytes`, for handlers that read
 * the body themselves (Better Auth, the OAuth provider). A declared length
 * above the limit throws `RequestBodyTooLarge` at once. A chunked body errors
 * when it passes the limit.
 */
export function limitRequestBody(request: Request, maxBytes: number): Request {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= maxBytes))
    throw new RequestBodyTooLarge();
  if (declared !== null || !request.body) return request;

  let size = 0;
  const body = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          controller.error(new RequestBodyTooLarge());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Request(request, { body, duplex: "half" } as RequestInit);
}
