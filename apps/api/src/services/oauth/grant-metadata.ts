import { projectScopeClaimSchema } from "@doxahq/contracts/agent-access";
import { z } from "zod";

/**
 * Stored unencrypted on the provider grant, so the grants list can show it
 * without a token. Grant props are encrypted and unreadable from a listing,
 * which is why the project scope is copied here. Holds no secrets.
 */
export const agentGrantMetadataSchema = z.object({
  clientName: z.string().min(1).max(200),
  cimd: z.boolean(),
  grantRef: z.uuid(),
  projectScope: projectScopeClaimSchema,
});

export type AgentGrantMetadata = z.infer<typeof agentGrantMetadataSchema>;
