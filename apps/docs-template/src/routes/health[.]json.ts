import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/health.json")({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          { ok: true, service: "doxa-docs-renderer" },
          {
            headers: {
              "cache-control": "no-store",
            },
          }
        ),
    },
  },
});
