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

  return Response.json(
    {
      method: request.method,
      path: normalizeEchoPath(path),
      query: readEchoQuery(url.searchParams),
      body: await readEchoBody(request),
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

async function readEchoBody(request: Request): Promise<unknown> {
  const body = await request.text();
  if (!body) return null;

  if (!isJsonContentType(request.headers.get("content-type"))) return body;

  try {
    const parsedBody: unknown = JSON.parse(body);
    return parsedBody;
  } catch {
    return body;
  }
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
