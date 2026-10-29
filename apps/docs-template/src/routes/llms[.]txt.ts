/**
 * /llms.txt — AI-native page index.
 *
 * Plain-text index of the site's published pages following the llms.txt
 * convention (https://llmstxt.org/). Consumed by external AI tools
 * (ChatGPT, Claude, Cursor, MCP clients) for discovery and citation.
 *
 * Entries are grouped by section when the site has more than one section.
 */

import { createFileRoute } from "@tanstack/react-router";

import {
  createLlmsResponse,
  formatLlmsIndex,
  LLMS_INDEX_LOAD_OPTIONS,
} from "@/src/lib/llms";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: ({ request, context }) =>
        createLlmsResponse(
          request,
          context,
          formatLlmsIndex,
          LLMS_INDEX_LOAD_OPTIONS
        ),
    },
  },
});
