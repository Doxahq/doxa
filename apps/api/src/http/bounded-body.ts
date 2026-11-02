export class RequestBodyTooLarge extends Error {}

/** Content-Length is advisory. The stream limit also covers chunked uploads. */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new RequestBodyTooLarge();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLarge();
      }
      chunks.push(chunk.value);
    }
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
