import { createFileRoute } from "@tanstack/react-router"
import { McpPage } from "~/components/marketing/mcp/mcp-page"
import { MCP_ART } from "~/lib/marketing/mcp-art"
import { marketingHead } from "~/lib/marketing/seo"

export const Route = createFileRoute("/_marketing/mcp")({
  head: () => {
    const head = marketingHead({
      path: "/mcp",
      title: "MCP server — Doxa",
      description:
        "Connect Claude Code, Cursor, VS Code, Codex and other agents to Doxa with the Doxa MCP server. Agents edit your docs on a branch, and you approve each publish.",
    })
    return {
      ...head,
      links: [
        ...head.links,
        {
          rel: "preload",
          as: "image",
          type: "image/avif",
          imageSrcSet: MCP_ART.avif,
          imageSizes: MCP_ART.sizes,
          fetchPriority: "high",
        },
      ],
    }
  },
  component: McpPage,
})
