import { z } from "zod";

/**
 * `GET /projects/:projectId/export/status`: whether the docs export can run
 * now. The dashboard reads it before it starts a download, because a plain
 * download link cannot show an error inside the page.
 */
export const docsExportUnavailableReasonSchema = z.enum(["no_published_version", "too_large", "quota_spent"]);
export type DocsExportUnavailableReason = z.infer<typeof docsExportUnavailableReasonSchema>;

export const docsExportQuotaSchema = z.object({
  available: z.boolean(),
  /** Null while billing enforcement is off. */
  plan: z.string().nullable(),
  /** 24 on Free, 1 on paid plans. Null when no quota applies. */
  windowHours: z.number().int().positive().nullable(),
  /** When the next export is possible. Null when no quota applies. */
  resetsAt: z.string().nullable(),
});
export type DocsExportQuota = z.infer<typeof docsExportQuotaSchema>;

export const docsExportStatusSchema = z.object({
  available: z.boolean(),
  reason: docsExportUnavailableReasonSchema.nullable(),
  version: z.object({ id: z.string(), number: z.number().int(), publishedAt: z.string() }).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  maxBytes: z.number().int().positive(),
  quota: docsExportQuotaSchema,
});
export type DocsExportStatus = z.infer<typeof docsExportStatusSchema>;
