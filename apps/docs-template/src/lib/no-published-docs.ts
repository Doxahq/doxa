/**
 * The answer for a host that has no published docs: a 404 with a short
 * static page. It runs before TanStack Start and without a site config, so
 * it carries no site data and no internal error details.
 */
const NO_PUBLISHED_DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Documentation not found</title>
<style>
:root { color-scheme: light dark; --background: #ffffff; --foreground: #0a0a0a; --muted: #525252; }
@media (prefers-color-scheme: dark) { :root { --background: #0a0a0a; --foreground: #fafafa; --muted: #a3a3a3; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; background: var(--background); color: var(--foreground); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center; }
h1 { margin: 0 0 12px; font-size: 48px; }
p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>404</h1>
<p>No documentation is published at this address.</p>
</main>
</body>
</html>
`;

export function noPublishedDocsResponse(request: Request): Response {
  const html = request.headers.get("accept")?.includes("text/html") ?? false;
  const headers = {
    "cache-control": "no-store",
    "content-type": html
      ? "text/html; charset=utf-8"
      : "text/plain; charset=utf-8",
  };
  if (request.method === "HEAD")
    return new Response(null, { status: 404, headers });
  return new Response(html ? NO_PUBLISHED_DOCS_HTML : "Not found", {
    status: 404,
    headers,
  });
}
