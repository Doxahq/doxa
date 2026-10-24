import { createRouter as createTanStackRouter } from "@tanstack/react-router"
import type { QueryClient } from "@tanstack/react-query"

import { getQueryClient } from "~/lib/query-client"
import { routeTree } from "./routeTree.gen"

export function createRouter(queryClient: QueryClient = getQueryClient()) {
  return createTanStackRouter({
    routeTree,
    // Route loaders read the QueryClient from here to start their requests.
    context: { queryClient },
    defaultPreload: "intent",
    scrollRestoration: true,
  })
}

/**
 * TanStack Start calls this once per request on the server and once in the
 * browser, so each server request gets its own QueryClient.
 */
export function getRouter() {
  return createRouter()
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}


{/* Terminal panels */ }
{/* <div className="mt-20 grid w-full max-w-4xl grid-cols-1 gap-4 md:grid-cols-3">
          <div className="terminal-window text-left">
            <div className="terminal-window-header">
              <div className="terminal-dot" />
              <div className="terminal-dot" />
              <div className="terminal-dot" />
              <span className="ml-2 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                CLI
              </span>
            </div>
            <div className="p-4 font-mono text-xs leading-relaxed text-muted-foreground">
              <p>
                <span className="text-primary">$</span> doxa init
              </p>
              <p className="mt-1 text-muted-foreground/60">
                Scanning repository...
              </p>
              <p className="mt-1 text-muted-foreground/60">Found 24 functions</p>
              <p className="mt-1 text-muted-foreground/60">Generating docs...</p>
              <p className="mt-1 text-emerald-500">Done in 3.2s</p>
            </div>
          </div>

          <div className="terminal-window text-left">
            <div className="terminal-window-header">
              <div className="terminal-dot" />
              <div className="terminal-dot" />
              <div className="terminal-dot" />
              <span className="ml-2 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                DOXA AGENT
              </span>
            </div>
            <div className="p-4 font-mono text-xs leading-relaxed text-muted-foreground">
              <p>
                <span className="text-primary">PR #142</span> merged
              </p>
              <p className="mt-1 text-muted-foreground/60">
                Detecting changes...
              </p>
              <p className="mt-1 text-muted-foreground/60">
                Updated: api/auth.md
              </p>
              <p className="mt-1 text-muted-foreground/60">
                Updated: api/users.md
              </p>
              <p className="mt-1 text-emerald-500">Docs synced</p>
            </div>
          </div>

          <div className="terminal-window text-left">
            <div className="terminal-window-header">
              <div className="terminal-dot" />
              <div className="terminal-dot" />
              <div className="terminal-dot" />
              <span className="ml-2 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                OUTPUT
              </span>
            </div>
            <div className="p-4 font-mono text-xs leading-relaxed text-muted-foreground">
              <p className="text-foreground">## authenticate()</p>
              <p className="mt-1 text-muted-foreground/60">
                Validates JWT token and
              </p>
              <p className="text-muted-foreground/60">returns user session.</p>
              <p className="mt-2 text-foreground">@param token</p>
              <p className="text-muted-foreground/60">string - Bearer token</p>
            </div>
          </div>
        </div> */}
{/* </div> */ }