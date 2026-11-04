import server from "./dist/server/server.js"
import { withSecurityHeaders } from "./config/security-headers.js"
import { looksSignedIn } from "./src/lib/auth/session-cookie.ts"
import { isMarketingPath } from "./src/lib/marketing/marketing-paths.ts"

export default {
  async fetch(request, env, ctx) {
    // Expose Cloudflare env vars to process.env for server functions
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") {
          process.env[key] = value
        }
      }
    }

    // `assets.run_worker_first` sends some marketing pages here first. A visitor
    // who does not look signed in gets the prerendered page; a signed-in visitor
    // gets a server render with the Dashboard button.
    const { pathname } = new URL(request.url)
    if (isMarketingPath(pathname)) {
      if (!looksSignedIn(request.headers.get("cookie"))) {
        const asset = await env.ASSETS.fetch(request)
        if (asset.status !== 404) return withSecurityHeaders(asset)
      }
      return withSecurityHeaders(personal(await server.fetch(request)))
    }

    return withSecurityHeaders(await server.fetch(request))
  },
}

/** A page rendered for one visitor must not be stored in a shared cache. */
function personal(response) {
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", "private, no-store")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
