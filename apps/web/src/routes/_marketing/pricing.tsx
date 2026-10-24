import { createFileRoute } from "@tanstack/react-router"
import { PricingPage } from "~/components/marketing/pricing/pricing-page"

export const Route = createFileRoute("/_marketing/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — Doxa" },
      { name: "description", content: "Start free with the full Doxa agent and a live docs site. Upgrade when your team needs more room." },
    ],
  }),
  component: PricingPage,
})
