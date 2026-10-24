import type { McpServer } from "@modelcontextprotocol/server";
import { siteConfigJsonSchema } from "@doxahq/site-config";

export const SITE_CONFIG_SCHEMA_URI = "doxa://schemas/site-config";
const ONE_HOUR_MS = 3_600_000;

export function registerSiteConfigSchemaResource(server: McpServer): void {
  server.registerResource(
    "site-config-schema",
    SITE_CONFIG_SCHEMA_URI,
    {
      title: "Site settings JSON schema",
      description: "The JSON schema of the site settings (doxa.json).",
      mimeType: "application/schema+json",
      cacheHint: { cacheScope: "public", ttlMs: ONE_HOUR_MS },
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/schema+json",
          text: JSON.stringify(siteConfigJsonSchema()),
        },
      ],
    }),
  );
}
