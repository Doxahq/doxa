import { createFileRoute, Outlet } from "@tanstack/react-router"

import { getMarketingViewer } from "~/server/marketing-viewer"
import marketingCss from "~/styles/marketing/index.css?url"

const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;700&family=JetBrains+Mono:wght@400&display=swap"

export const Route = createFileRoute("/_marketing")({
  head: () => ({
    links: [
      { rel: "stylesheet", href: FONTS_URL },
      { rel: "stylesheet", href: marketingCss },
    ],
  }),
  // The server render reads the cookie once. Moving between marketing pages
  // keeps the result; leaving the marketing pages drops it, so a sign-out in
  // the dashboard shows on the next visit.
  loader: () => getMarketingViewer(),
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: 0,
  component: MarketingLayout,
})

function MarketingLayout() {
  return (
    <main>
      <Outlet />
    </main>
  )
}
