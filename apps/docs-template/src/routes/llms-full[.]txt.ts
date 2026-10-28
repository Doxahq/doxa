/**
 * /llms-full.txt — Full documentation corpus as a single plain-text file.
 *
 * Concatenates the site's published pages into one document consumable by
 * external AI assistants as a single-file knowledge dump. Each page is
 * prefixed with its source URL for citation. Follows the llms-full.txt
 * convention.
 *
 * When the site has more than one section, pages are grouped by section with
 * a leading section header so the section context is preserved.
 */

import { createFileRoute } from "@tanstack/react-router";

import { createLlmsResponse, formatLlmsFull } from "@/src/lib/llms";

export const Route = createFileRoute("/llms-full.txt")({
  server: {
    handlers: {
      GET: ({ request, context }) =>
        createLlmsResponse(request, context, formatLlmsFull),
    },
  },
});
