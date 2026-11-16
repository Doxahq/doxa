import { createFileRoute } from "@tanstack/react-router"

import { listBlogPosts } from "~/lib/marketing/blog"
import { formatSitemap, listSitemapEntries } from "~/lib/marketing/sitemap"

// The build prerenders this route to the static file `/sitemap.xml` (vite.config.ts).
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(formatSitemap(listSitemapEntries(listBlogPosts())), {
          headers: { "Content-Type": "application/xml; charset=utf-8" },
        }),
    },
  },
})
