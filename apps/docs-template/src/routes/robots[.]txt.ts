import { createFileRoute } from "@tanstack/react-router";

import { createRobotsResponse } from "@/src/lib/robots";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: ({ request }) => createRobotsResponse(request),
    },
  },
});
