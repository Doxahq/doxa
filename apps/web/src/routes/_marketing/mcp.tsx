import { createFileRoute } from "@tanstack/react-router"
import { McpPage } from "~/components/marketing/mcp/mcp-page"
import { marketingHead } from "~/lib/marketing/seo"

export const Route = createFileRoute("/_marketing/mcp")({
  // No image preload: a preload cannot know the theme, so light visitors would
  // download the night photo too. ThemedPicture loads only the photo on show.
  head: () =>
    marketingHead({
      path: "/mcp",
      title: "MCP server — Doxa",
      description:
        "Connect Claude Code, Cursor, VS Code, Codex and other agents to Doxa with the Doxa MCP server. Agents edit your docs on a branch, and you approve each publish.",
    }),
  component: McpPage,
})
