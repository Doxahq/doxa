/**
 * /robots.txt of the requesting site. It allows every crawler and names the
 * sitemap of the same hostname. Previews stay out of search results through
 * their `noindex` header, which a crawler must be allowed to fetch to see.
 */

const ROBOTS_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
} as const;

export function formatRobots(origin: string): string {
  return ["User-agent: *", "Allow: /", "", `Sitemap: ${origin}/sitemap.xml`, ""].join(
    "\n"
  );
}

export function createRobotsResponse(request: Request): Response {
  return new Response(formatRobots(new URL(request.url).origin), {
    headers: ROBOTS_HEADERS,
  });
}
