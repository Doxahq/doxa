import { createFileRoute } from "@tanstack/react-router"

import { analyticsConfigResponse } from "~/server/analytics-config"

// The region and the PostHog connection of this visitor. No static file has
// this path, so the assets binding misses and the Worker answers.
export const Route = createFileRoute("/api/analytics-config")({
  server: {
    handlers: {
      GET: ({ request }) => analyticsConfigResponse(request),
    },
  },
})
