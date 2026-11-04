import { createFileRoute } from "@tanstack/react-router"
import { TermsOfServicePage } from "~/components/marketing/legal/terms-of-service-page"
import { LEGAL_DOCS } from "~/lib/marketing/legal"

export const Route = createFileRoute("/_marketing/legal/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service — Doxa" },
      { name: "description", content: LEGAL_DOCS.terms.summary },
    ],
  }),
  component: TermsOfServicePage,
})
