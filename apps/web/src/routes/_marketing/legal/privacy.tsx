import { createFileRoute } from "@tanstack/react-router"
import { PrivacyPolicyPage } from "~/components/marketing/legal/privacy-policy-page"
import { LEGAL_DOCS } from "~/lib/marketing/legal"
import { marketingHead } from "~/lib/marketing/seo"

export const Route = createFileRoute("/_marketing/legal/privacy")({
  head: () =>
    marketingHead({
      path: LEGAL_DOCS.privacy.path,
      title: "Privacy Policy — Doxa",
      description: LEGAL_DOCS.privacy.summary,
    }),
  component: PrivacyPolicyPage,
})
