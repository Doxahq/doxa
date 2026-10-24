import {
  docsResolverRequestSchema,
  type DocsResolver,
} from "@doxahq/contracts/docs-resolver";
import { toSafeErrorLog } from "./error-log";

/** Deployed only by the private resolver Worker, not mounted on the public API. */
export async function handleDocsResolverRequest(
  request: Request,
  resolver: DocsResolver,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health" && request.method === "GET") {
    return respond({ ok: true, service: "doxa-docs-resolver" });
  }
  if (path !== "/resolve") return respond({ error: "Not found." }, 404);
  if (request.method !== "POST")
    return respond({ error: "Method not allowed." }, 405);

  const parsed = docsResolverRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return respond({ error: "Invalid resolution request." }, 400);

  try {
    const { kind, value } = parsed.data;
    switch (kind) {
      case "host":
        return respond({ resolution: await resolver.resolveDocsHost(value) });
      case "project":
        return respond({
          resolution: await resolver.resolveDocsProject(value),
        });
      case "slug":
        return respond({ resolution: await resolver.resolveDocsSite(value) });
    }
  } catch (error) {
    console.error("Docs resolution failed.", toSafeErrorLog(error));
    return respond(
      { error: "Docs resolution is temporarily unavailable." },
      503,
    );
  }
}

function respond(body: unknown, status = 200): Response {
  // Edge consumers retain their existing caches and invalidation rules.
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
