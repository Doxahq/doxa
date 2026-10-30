/**
 * /sitemap.xml — the pages of the requesting site, for search engines.
 *
 * A build with its own content can also emit a static sitemap.xml asset,
 * which Workers Assets serves first. The platform renderer build does not, so
 * every published site gets this route.
 */

import { createFileRoute } from "@tanstack/react-router";

import { createSitemapResponse } from "@/src/lib/sitemap";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: ({ request, context }) => createSitemapResponse(request, context),
    },
  },
});
