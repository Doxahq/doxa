import { createFileRoute } from "@tanstack/react-router"
import { PrivacyPolicyPage } from "~/components/marketing/legal/privacy-policy-page"
import { LEGAL_DOCS } from "~/lib/marketing/legal"

export const Route = createFileRoute("/_marketing/legal/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — Doxa" },
      { name: "description", content: LEGAL_DOCS.privacy.summary },
    ],
  }),
  component: PrivacyPolicyPage,
})
