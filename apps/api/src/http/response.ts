import type { ValidationIssue } from "@doxahq/contracts/validation";

export function validationError(
  issues: readonly ValidationIssue[],
  message?: string,
): Response {
  const count = issues.filter((issue) => issue.severity === "error").length;
  return error(message ?? `The site settings have ${count} errors.`, 422, {
    code: "validation_failed",
    issues,
  });
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

export function error(
  message: string,
  status = 400,
  details?: unknown,
): Response {
  return json({ error: { message, details } }, { status });
}

export function notFound(): Response {
  return error("Not found", 404);
}

export function withCors(
  response: Response,
  request: Request,
  allowedOrigin?: string,
): Response {
  const origin = request.headers.get("origin");
  const headers = new Headers(response.headers);

  if (origin && (!allowedOrigin || origin === allowedOrigin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("vary", appendVary(headers.get("vary"), "Origin"));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function corsPreflight(
  request: Request,
  allowedOrigin?: string,
): Response {
  const origin = request.headers.get("origin");
  const headers = new Headers();

  if (origin && (!allowedOrigin || origin === allowedOrigin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
  }

  headers.set(
    "access-control-allow-methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  headers.set(
    "access-control-allow-headers",
    "content-type,authorization,x-doxa-user-id",
  );
  headers.set("access-control-max-age", "86400");

  return new Response(null, { status: 204, headers });
}

function appendVary(current: string | null, value: string): string {
  if (!current) return value;
  return current.includes(value) ? current : `${current}, ${value}`;
}
