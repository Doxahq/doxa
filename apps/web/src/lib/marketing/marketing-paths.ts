/**
 * The marketing pages that change for a signed-in visitor. `assets.run_worker_first`
 * in `wrangler.json` lists the same paths, so `worker.js` sees these requests
 * before the static files: a visitor with a session cookie gets a server render
 * with the Dashboard button, and everyone else gets the prerendered page. The
 * other marketing pages are always the prerendered files.
 */
const MARKETING_PATHS = new Set(["/", "/pricing"])

/** True for one of these page paths, with or without a trailing slash. */
export function isMarketingPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  return MARKETING_PATHS.has(path)
}
