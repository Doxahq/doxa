import { z } from "zod";

export const docsCacheInvalidationSchema = z.object({
  siteId: z.string().min(1).max(128),
  hostname: z.string().min(1).max(253).optional(),
});

export type DocsCacheInvalidation = z.infer<typeof docsCacheInvalidationSchema>;

/** Private service binding only. A resolved call means the purge was accepted. */
export interface DocsCacheInvalidationRpc {
  invalidate(input: DocsCacheInvalidation): Promise<void>;
}
