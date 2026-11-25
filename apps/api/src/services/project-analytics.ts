import type { ProductEventProperties } from "@doxahq/analytics";
import type { Env } from "../env";
import { productAnalyticsOf } from "./analytics/product-analytics";

/** The surface that created a project: the dashboard, or an agent through MCP. */
export type ProjectCreationVia = ProductEventProperties<"project_created">["via"];

/** `project_created`, once the project exists. */
export function captureProjectCreated(
  env: Env,
  input: { userId: string; projectId: string; source: ProductEventProperties<"project_created">["source"]; via: ProjectCreationVia },
): void {
  productAnalyticsOf(env).capture({
    name: "project_created",
    distinctId: input.userId,
    properties: { source: input.source, via: input.via },
    groups: { project: input.projectId },
  });
}
