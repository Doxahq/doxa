import { createFileRoute } from "@tanstack/react-router"
import { McpPage } from "~/components/marketing/mcp/mcp-page"
import { MCP_ART } from "~/lib/marketing/mcp-art"

export const Route = createFileRoute("/_marketing/mcp")({
  head: () => ({
    meta: [
      { title: "MCP server — Doxa" },
      { name: "description", content: "Connect Claude Code, Cursor, VS Code, Codex and other agents to Doxa with the Doxa MCP server." },
    ],
    links: [
      {
        rel: "preload",
        as: "image",
        type: "image/avif",
        imageSrcSet: MCP_ART.avif,
        imageSizes: MCP_ART.sizes,
        fetchPriority: "high",
      },
    ],
  }),
  component: McpPage,
})
