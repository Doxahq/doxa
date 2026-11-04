import { createFileRoute } from "@tanstack/react-router"
import { AgentPage } from "~/components/marketing/agent/agent-page"

export const Route = createFileRoute("/_marketing/agent")({
  head: () => ({
    meta: [
      { title: "Doxabot — Doxa" },
      {
        name: "description",
        content:
          "Doxabot reads your GitHub repository, writes your docs and API reference, previews every pull request, and publishes only what you approve.",
      },
    ],
  }),
  component: AgentPage,
})
