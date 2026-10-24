import { z } from "zod";
import { domainCheckAction } from "@doxahq/api/services/agent-actions/actions/domain-check";
import { defineActionTool } from "../action-tool";
import { projectIdInput } from "../shared";

export const checkDomainTool = defineActionTool({
  name: "check_domain",
  title: "Check a custom domain",
  description:
    "Asks Cloudflare again for the DNS and certificate state of a custom domain, and returns the updated domain.",
  action: "domain.check",
  scope: "domains:write",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      projectId: projectIdInput,
      domainId: z.uuid().describe("The domain ID, from list_domains."),
    })
    .strict(),
  result: domainCheckAction.resultSchema,
  toCall: (input) => ({ projectId: input.projectId, payload: { domainId: input.domainId } }),
});
