import { createFileRoute } from "@tanstack/react-router"
import { TermsOfServicePage } from "~/components/marketing/legal/terms-of-service-page"
import { LEGAL_DOCS } from "~/lib/marketing/legal"
import { marketingHead } from "~/lib/marketing/seo"

export const Route = createFileRoute("/_marketing/legal/terms")({
  head: () =>
    marketingHead({
      path: LEGAL_DOCS.terms.path,
      title: "Terms of Service — Doxa",
      description: LEGAL_DOCS.terms.summary,
    }),
  component: TermsOfServicePage,
})
