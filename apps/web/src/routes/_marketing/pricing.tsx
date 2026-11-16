import { createFileRoute } from "@tanstack/react-router"
import { PricingPage } from "~/components/marketing/pricing/pricing-page"
import { marketingHead } from "~/lib/marketing/seo"

export const Route = createFileRoute("/_marketing/pricing")({
  head: () =>
    marketingHead({
      path: "/pricing",
      title: "Pricing — Doxa",
      description:
        "Start free with the full Doxa agent and a live docs site. Upgrade when your team needs more room.",
    }),
  component: PricingPage,
})
