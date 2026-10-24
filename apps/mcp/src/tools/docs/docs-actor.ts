import type { DocsContentActor } from "@doxahq/api/services/docs-content/service";
import { editOriginFor } from "@doxahq/api/services/agent-access/actor";
import type { AuthorizedProject } from "@doxahq/api/services/agent-access/project-access-policy";
import type { ToolContext } from "../../tool-definition";

/** The docs services still take a user ID; it is the project owner's (spec 7.4). */
export function docsActorFor(
  context: ToolContext,
  authorized: AuthorizedProject,
): DocsContentActor {
  return {
    userId: authorized.ownerUserId,
    origin: editOriginFor(context.actor),
  };
}
