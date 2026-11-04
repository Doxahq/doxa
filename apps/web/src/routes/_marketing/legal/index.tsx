import { createFileRoute } from "@tanstack/react-router"
import { LegalIndexPage } from "~/components/marketing/legal/legal-index-page"

export const Route = createFileRoute("/_marketing/legal/")({
  head: () => ({
    meta: [
      { title: "Legal — Doxa" },
      { name: "description", content: "The Doxa Terms of Service and Privacy Policy." },
    ],
  }),
  component: LegalIndexPage,
})
