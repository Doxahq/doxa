/// <reference types="vite/client" />
import type { ReactNode } from "react"
import type { QueryClient } from "@tanstack/react-query"
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router"
import { SIDEBAR_WIDTH_SCRIPT } from "~/lib/dashboard/sidebar-width"
import { AppQueryProvider } from "~/lib/query-client"

import globalsCss from "~/styles/globals.css?url"

/** What every route loader receives in `context`. `getRouter()` creates it. */
export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: ({ matches }) => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: matches.some((match) => match.globalNotFound || match.status === "notFound")
          ? "Page not found — Doxa"
          : "Doxa — Documentation that Updates Itself",
      },
      {
        name: "description",
        content:
          "Doxa keeps your documentation in sync with your codebase. CLI tools, templates, and an AI agent that watches your PRs.",
      },
    ],
    links: [
      { rel: "stylesheet", href: globalsCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800&family=Sora:wght@400;600;700&display=swap",
        as: "style",
      },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  const { queryClient } = Route.useRouteContext()
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var l=document.createElement("link");l.rel="stylesheet";l.href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800&family=Sora:wght@400;600;700&display=swap";document.head.appendChild(l)})()`,
          }}
        />
        {/* The saved dashboard sidebar width, applied before the first paint. */}
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_WIDTH_SCRIPT }} />
        <noscript>
          <link
            rel="stylesheet"
            href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800&family=Sora:wght@400;600;700&display=swap"
          />
        </noscript>
      </head>
      <body>
        <AppQueryProvider client={queryClient}>{children}</AppQueryProvider>
        <Scripts />
      </body>
    </html>
  )
}
