import { z } from "zod";
import { gitObjectIdSchema } from "./source-control";
import { normalizedSourcePathSchema } from "./source-checkout";

export const WRITER_HANDOFF_SCHEMA_VERSION = 1 as const;

const uniqueStringsSchema = z.array(z.string().trim().min(1)).superRefine(
  (values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "Values must be unique." });
    }
  },
);

export const writerSourceEvidenceSchema = z.object({
  path: normalizedSourcePathSchema,
  symbols: uniqueStringsSchema,
  reason: z.string().trim().min(1),
}).strict();

export const writerPageBriefSchema = z.object({
  pageId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  route: z.string().trim().min(1),
  pageType: z.string().trim().min(1),
  purpose: z.string().trim().min(1),
  requiredTopics: uniqueStringsSchema,
  sourceEvidence: z.array(writerSourceEvidenceSchema),
  relatedPageIds: uniqueStringsSchema,
  exclusions: uniqueStringsSchema,
}).strict();

export const writerHandoffManifestSchema = z.object({
  schemaVersion: z.literal(WRITER_HANDOFF_SCHEMA_VERSION),
  sourceRevision: gitObjectIdSchema.nullable(),
  project: z.object({
    name: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    audience: z.string().trim().min(1),
    documentationGoal: z.string().trim().min(1),
  }).strict(),
  shared: z.object({
    terminology: uniqueStringsSchema,
    factualConstraints: uniqueStringsSchema,
    editorialConstraints: uniqueStringsSchema,
    validationConstraints: uniqueStringsSchema,
  }).strict(),
  pages: z.array(writerPageBriefSchema).min(1),
}).strict().superRefine((manifest, context) => {
  const pageIds = manifest.pages.map((page) => page.pageId);
  if (new Set(pageIds).size !== pageIds.length) {
    context.addIssue({
      code: "custom",
      path: ["pages"],
      message: "Writer handoff page IDs must be unique.",
    });
  }
});

export type WriterSourceEvidence = z.infer<typeof writerSourceEvidenceSchema>;
export type WriterPageBrief = z.infer<typeof writerPageBriefSchema>;
export type WriterHandoffManifest = z.infer<typeof writerHandoffManifestSchema>;
