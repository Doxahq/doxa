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
