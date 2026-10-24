import { z } from "zod";

export const searchLineSchema = z.object({
  text: z.string(),
  anchor: z.string().optional(),
});

export const runtimeSearchDocumentSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  breadcrumb: z.array(z.string()),
  icon: z.string().optional(),
  section: z.string(),
  headings: z.array(z.string()),
  keywords: z.array(z.string()),
  content: z.string(),
  lines: z.array(searchLineSchema),
});

export const runtimeSearchArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  contentVersion: z.string().min(1),
  documents: z.array(runtimeSearchDocumentSchema),
});

export const compiledSearchArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  contentVersion: z.string().min(1),
  serializedIndex: z.string().min(1),
});

export const runtimeSearchQuerySchema = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(1).max(50).default(8),
});

export const runtimeSearchResultSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  breadcrumb: z.array(z.string()),
  icon: z.string().optional(),
  section: z.string().optional(),
  snippetLine: z.string(),
  snippetAnchor: z.string().optional(),
  score: z.number(),
  terms: z.array(z.string()),
});

export const runtimeSearchResponseSchema = z.object({
  results: z.array(runtimeSearchResultSchema),
});

export type RuntimeSearchDocument = z.infer<typeof runtimeSearchDocumentSchema>;
export type RuntimeSearchArtifact = z.infer<typeof runtimeSearchArtifactSchema>;
export type CompiledSearchArtifact = z.infer<
  typeof compiledSearchArtifactSchema
>;
export type RuntimeSearchQuery = z.infer<typeof runtimeSearchQuerySchema>;
export type RuntimeSearchResult = z.infer<typeof runtimeSearchResultSchema>;
export type SearchIndexLine = RuntimeSearchDocument["lines"][number];
