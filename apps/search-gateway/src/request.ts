import { DOCS_SEARCH_GATEWAY_LIMITS } from "@doxahq/contracts/docs-search";
import { z } from "zod";

const querySchema = z.object({
  query: z
    .string()
    .trim()
    .min(DOCS_SEARCH_GATEWAY_LIMITS.minQueryLength)
    .max(DOCS_SEARCH_GATEWAY_LIMITS.maxQueryLength),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(DOCS_SEARCH_GATEWAY_LIMITS.maxResults)
    .default(DOCS_SEARCH_GATEWAY_LIMITS.defaultResults),
});

export type GatewayQuery = z.infer<typeof querySchema>;

export function parseGatewayQuery(url: URL): GatewayQuery | null {
  const limit = url.searchParams.get("limit");
  const parsed = querySchema.safeParse({
    query: url.searchParams.get("q") ?? "",
    ...(limit === null ? {} : { limit }),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The hostname of the docs page that sent the search.
 *
 * SECURITY: the site comes from the browser's `Origin` header and never from a
 * parameter, so a page can only search its own site. A script can send any
 * `Origin`, but it then reaches only a public site's public text: the same
 * text that the site serves to anyone. Private sites never have a remote index.
 */
export function readPageHostname(
  request: Request,
  allowHttp: boolean,
): { origin: string; hostname: string } | null {
  const origin = request.headers.get("origin");
  if (!origin || !URL.canParse(origin)) return null;
  const url = new URL(origin);
  const allowed =
    url.protocol === "https:" || (allowHttp && url.protocol === "http:");
  if (!allowed || url.origin !== origin) return null;
  return { origin, hostname: url.hostname };
}
