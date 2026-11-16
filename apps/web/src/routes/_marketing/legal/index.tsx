import { createFileRoute } from "@tanstack/react-router"
import { LegalIndexPage } from "~/components/marketing/legal/legal-index-page"
import { marketingHead } from "~/lib/marketing/seo"

export const Route = createFileRoute("/_marketing/legal/")({
  head: () =>
    marketingHead({
      path: "/legal",
      title: "Legal — Doxa",
      description:
        "The Doxa Terms of Service and Privacy Policy: the agreement for the hosted service, and how Doxa collects, uses and protects your data.",
    }),
  component: LegalIndexPage,
})
