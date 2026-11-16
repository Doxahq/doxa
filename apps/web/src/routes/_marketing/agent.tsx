import { createFileRoute } from "@tanstack/react-router"
import { AgentPage } from "~/components/marketing/agent/agent-page"
import { marketingHead } from "~/lib/marketing/seo"

export const Route = createFileRoute("/_marketing/agent")({
  head: () =>
    marketingHead({
      path: "/agent",
      title: "Doxabot — Doxa",
      description:
        "Doxabot reads your GitHub repository, writes your docs and API reference, previews every pull request, and publishes only what you approve.",
    }),
  component: AgentPage,
})
