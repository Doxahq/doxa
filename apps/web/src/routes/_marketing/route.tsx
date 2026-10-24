import { createFileRoute, Outlet } from "@tanstack/react-router"

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
  component: MarketingLayout,
})

function MarketingLayout() {
  return (
    <main>
      <Outlet />
    </main>
  )
}
