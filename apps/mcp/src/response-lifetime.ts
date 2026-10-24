/**
 * Runs `release` once the response body has been fully sent or cancelled.
 * A 2025 client gets an SSE stream that the tool may still be writing after
 * the handler returns, so the database pool must outlive the handler call.
 */
export function releaseAfterBody(
  response: Response,
  release: () => Promise<void>,
  waitUntil: (promise: Promise<unknown>) => void,
): Response {
  if (!response.body) {
    waitUntil(release());
    return response;
  }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  waitUntil(
    response.body
      .pipeTo(writable)
      .catch(() => undefined)
      .finally(release),
  );
  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
