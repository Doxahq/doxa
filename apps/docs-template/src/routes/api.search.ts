import type { DocsRequestContext } from "@/src/runtime/request-context";
import type { DoxaDocsRuntimeSource } from "@/src/runtime/runtime-source";
import { createConfiguredRuntimeSource } from "@/src/runtime/runtime-source-selection";
import { runtimeSearchQuerySchema } from "@doxahq/docs-search/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { searchRuntimeDocs } from "@/src/lib/search/server-search";

const RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

export async function createSearchResponse(
  request: Request,
  source?: DoxaDocsRuntimeSource
): Promise<Response> {
  const url = new URL(request.url);
  const parsed = runtimeSearchQuerySchema.safeParse({
    query: url.searchParams.get("q") ?? "",
    limit: Number(url.searchParams.get("limit") ?? 8),
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Enter between 2 and 200 characters to search." },
      { status: 400, headers: RESPONSE_HEADERS }
    );
  }

  const runtimeSource = source ?? (await createConfiguredRuntimeSource());
  const results = await searchRuntimeDocs(
    runtimeSource,
    parsed.data.query,
    parsed.data.limit
  );
  return Response.json({ results }, { headers: RESPONSE_HEADERS });
}

export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      GET: ({ request, context }) =>
        createSearchResponse(
          request,
          ((context ?? {}) as DocsRequestContext).runtimeSource
        ),
    },
  },
});
