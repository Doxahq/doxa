import { z } from "zod";
import { domainAddAction } from "@doxahq/api/services/agent-actions/actions/domain-add";
import { additiveActionAnnotations, defineActionTool } from "../action-tool";
import { projectIdInput } from "../shared";

export const addDomainTool = defineActionTool({
  name: "add_domain",
  title: "Add a custom domain",
  description:
    "Adds a custom domain to the docs site. When it completes, the result lists the DNS records that the user must create.",
  action: "domain.add",
  liveActivityKind: "domain",
  scope: "domains:write",
  annotations: additiveActionAnnotations,
  input: z
    .object({
      projectId: projectIdInput,
      hostname: z.string().trim().min(1).max(253).describe("For example docs.example.com."),
    })
    .strict(),
  result: domainAddAction.resultSchema,
  toCall: (input) => ({ projectId: input.projectId, payload: { hostname: input.hostname } }),
});
