/// <reference types="vite/client" />
import type { ReactNode } from "react"
import type { QueryClient } from "@tanstack/react-query"
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router"
import { AnalyticsRoot } from "~/components/analytics/analytics-root"
import { SIDEBAR_WIDTH_SCRIPT } from "~/lib/dashboard/sidebar-width"
import { AppQueryProvider } from "~/lib/query-client"
import { THEME_SCRIPT } from "~/lib/theme/theme"

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
        title: matches.some((match) => match._notFound || match.status === "notFound")
          ? "Page not found — Doxa"
          : "Doxa — Documentation that updates itself",
      },
      {
        name: "description",
        content:
          "Doxa keeps your documentation in sync with your codebase, with templates and an AI agent that watches your PRs.",
      },
      // Only the marketing pages belong in search results. The marketing layout
      // turns indexing on; sign-in, the dashboard and the 404 page stay out.
      { name: "robots", content: "noindex, nofollow" },
    ],
    links: [
      { rel: "stylesheet", href: globalsCss },
      { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
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
    // The head script sets `data-theme` before React hydrates, so the server
    // markup and the page can differ on that one attribute.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* The saved color theme, applied before the first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
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
        <AppQueryProvider client={queryClient}>
          {children}
          <AnalyticsRoot />
        </AppQueryProvider>
        <Scripts />
      </body>
    </html>
  )
}
