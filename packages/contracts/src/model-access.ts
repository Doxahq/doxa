import { z } from "zod";

/**
 * A short-lived Anthropic access token from Workload Identity Federation.
 * The API mints it from the origin's cloud identity, so no long-lived model
 * key is stored. It only allows inference, in one workspace.
 */
export const modelAccessTokenSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
}).strict();

export type ModelAccessToken = z.infer<typeof modelAccessTokenSchema>;
