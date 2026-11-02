import { createFileRoute } from "@tanstack/react-router";

type EchoQuery = Record<string, string | string[]>;

interface EchoRouteHandlerContext {
  request: Request;
  params: { _splat?: string };
}

async function handleEchoRoute({
  request,
  params,
}: EchoRouteHandlerContext): Promise<Response> {
  return createEchoResponse(request, params._splat);
}

export async function createEchoResponse(
  request: Request,
  path: string | undefined
): Promise<Response> {
  const url = new URL(request.url);
  const authorization = request.headers.has("authorization")
    ? "[REDACTED]"
    : null;

  let body: unknown;
  try {
    body = await readEchoBody(request);
  } catch (cause) {
    if (!(cause instanceof EchoBodyTooLarge)) throw cause;
    return Response.json(
      { error: "Request body is too large." },
      { status: 413, headers: { "cache-control": "no-store" } }
    );
  }

  return Response.json(
    {
      method: request.method,
      path: normalizeEchoPath(path),
      query: readEchoQuery(url.searchParams),
      body,
      authorization,
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    }
  );
}

function normalizeEchoPath(path: string | undefined): string {
  const normalized = path?.replace(/^\/+/, "") ?? "";
  return normalized ? `/${normalized}` : "/";
}

function readEchoQuery(searchParams: URLSearchParams): EchoQuery {
  const query: EchoQuery = {};

  for (const [name, value] of searchParams) {
    const existing = query[name];
    if (existing === undefined) {
      query[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[name] = [existing, value];
    }
  }

  return query;
}

/** The echo route answers demo requests, which are small (SEC-007). */
export const ECHO_BODY_MAX_BYTES = 64 * 1024;

class EchoBodyTooLarge extends Error {}

async function readEchoBody(request: Request): Promise<unknown> {
  const body = await readBoundedText(request, ECHO_BODY_MAX_BYTES);
  if (!body) return null;

  if (!isJsonContentType(request.headers.get("content-type"))) return body;

  try {
    const parsedBody: unknown = JSON.parse(body);
    return parsedBody;
  } catch {
    return body;
  }
}

async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (Number(request.headers.get("content-length")) > maxBytes) {
    throw new EchoBodyTooLarge();
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new EchoBodyTooLarge();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export const Route = createFileRoute("/api/echo/$")({
  server: {
    handlers: {
      GET: handleEchoRoute,
      POST: handleEchoRoute,
      PUT: handleEchoRoute,
      PATCH: handleEchoRoute,
      DELETE: handleEchoRoute,
    },
  },
});
