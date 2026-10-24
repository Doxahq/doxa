import { docsDomainCollectionSchema } from "@doxahq/contracts";
import { z } from "zod";
import { ToolNotFoundError } from "../../errors";
import { defineMcpTool } from "../../tool-definition";
import { projectIdInput, READ_ONLY_ANNOTATIONS } from "../shared";

export const listDomainsTool = defineMcpTool({
  name: "list_domains",
  title: "List domains",
  description:
    "Lists the domains of a project's docs site: the Doxa subdomain and any custom domains, with verification and routing status and the DNS record a custom domain needs.",
  scope: "projects:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z.object({ projectId: projectIdInput }).strict(),
  output: docsDomainCollectionSchema,
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "domains.read");
    const collection = await context.services.domains.listForProject({
      userId: authorized.ownerUserId,
      projectId: authorized.projectId,
    });
    if (!collection) throw new ToolNotFoundError("Docs site");
    return collection;
  },
});
