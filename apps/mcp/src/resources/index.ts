import type { McpServer } from "@modelcontextprotocol/server";
import type { McpRequestContext } from "../request-context";
import { registerMdxReferenceResource } from "./mdx-reference";
import { registerPageResource } from "./pages";
import { registerSiteConfigSchemaResource } from "./site-config-schema";

export function registerResources(
  server: McpServer,
  context: McpRequestContext,
): void {
  registerPageResource(server, context);
  registerSiteConfigSchemaResource(server);
  registerMdxReferenceResource(server);
}
