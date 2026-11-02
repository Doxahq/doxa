import server from "./dist/server/server.js"
import { withSecurityHeaders } from "./config/security-headers.js"

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
    return withSecurityHeaders(await server.fetch(request))
  },
}
