import { readBoundedBody, RequestBodyTooLarge } from "@doxahq/api/http/bounded-body";

/**
 * Spec 9.1: a bigger body gets 413 before MCP parsing. v2 raised it from
 * 4 MiB: an `upload_asset` call carries up to 5 MB of image as base64.
 */
export const MAX_MCP_BODY_BYTES = 8 * 1024 * 1024;

export type BoundedRequest =
  | { readonly kind: "ok"; readonly request: Request }
  | { readonly kind: "too_large" };

/** Reads the body once, within the limit, and returns a replayable request. */
export async function boundRequestBody(
  request: Request,
): Promise<BoundedRequest> {
  if (request.body === null) return { kind: "ok", request };
  try {
    const body = await readBoundedBody(request, MAX_MCP_BODY_BYTES);
    return {
      kind: "ok",
      request: new Request(request.url, {
        method: request.method,
        headers: request.headers,
        // MCP bodies are JSON-RPC text, so a string replays them exactly.
        body: new TextDecoder().decode(body),
      }),
    };
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) return { kind: "too_large" };
    throw error;
  }
}

export function payloadTooLargeResponse(): Response {
  return Response.json(
    {
      error: "payload_too_large",
      message: "The request body is larger than 8 MiB.",
    },
    { status: 413 },
  );
}
