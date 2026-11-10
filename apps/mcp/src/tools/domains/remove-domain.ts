import { z } from "zod";
import { domainRemoveAction } from "@doxahq/api/services/agent-actions/actions/domain-remove";
import { defineActionTool, destructiveActionAnnotations } from "../action-tool";
import { projectIdInput } from "../shared";

export const removeDomainTool = defineActionTool({
  name: "remove_domain",
  title: "Remove a custom domain",
  description: "Removes a custom domain. The site stops at that address.",
  action: "domain.remove",
  liveActivityKind: "domain",
  scope: "domains:write",
  annotations: destructiveActionAnnotations,
  input: z
    .object({
      projectId: projectIdInput,
      domainId: z.uuid().describe("The domain ID, from list_domains."),
    })
    .strict(),
  result: domainRemoveAction.resultSchema,
  toCall: (input) => ({ projectId: input.projectId, payload: { domainId: input.domainId } }),
});
