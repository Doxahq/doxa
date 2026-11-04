import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { defineConfig, loadEnv } from "vite"
import tsConfigPaths from "vite-tsconfig-paths"

import { collaborationStubAlias } from "./config/collaboration-stub-alias"
import { assertSafeProductionEnv } from "./config/production-env"

const appRoot = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig(({ command, mode }) => {
  // Deploy builds set DOXA_WEB_RELEASE. A local `vite build` keeps working with
  // .env.local, but a release must never ship local development settings.
  if (command === "build" && process.env.DOXA_WEB_RELEASE === "1") {
    assertSafeProductionEnv(loadEnv(mode, appRoot, "VITE_"))
  }

  return {
    resolve: {
      alias: collaborationStubAlias,
    },
    server: {
      port: 3001,
      allowedHosts: ["dev.doxa.so", "doxa.so"]
    },
    plugins: [
      tsConfigPaths({
        projects: ["./tsconfig.json"],
      }),
      tailwindcss(),
      tanstackStart({
        prerender: {
          enabled: true,
          crawlLinks: true,
          // Pages behind a session render per request. The OAuth consent page
          // and the email unsubscribe page must also send their own headers
          // (frame-ancestors 'none'), and the unsubscribe page reads its query.
          // The login and sign-up pages check the session on the server for each
          // visit, and the reset password page reads the token in its query.
          filter: ({ path }) =>
            !path.startsWith("/dashboard")
            && !path.startsWith("/oauth")
            && !path.startsWith("/email/")
            && path !== "/login"
            && path !== "/signup"
            && path !== "/reset-password",
        },
      }),
      viteReact(),
    ],
  }
})
