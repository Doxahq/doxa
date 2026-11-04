import { escapeHtml } from "@doxahq/contracts/html-escape";

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

/**
 * Shown when the request cannot be sent back to the agent: the client or its
 * redirect URI is not verified, so redirecting could hand an error (or the
 * user) to an attacker's URL.
 */
export function authorizeErrorPage(description: string, status = 400): Response {
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorization failed - Doxa</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1>Authorization failed</h1>
<p>${escapeHtml(description)}</p>
<p>Close this window and try to connect the agent again.</p>
</body>
</html>`;
  return new Response(body, { status, headers: PAGE_HEADERS });
}
