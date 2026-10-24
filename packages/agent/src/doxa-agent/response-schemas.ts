import { z } from "zod";
import type { ResponseSchema } from "../core";

/**
 * JSON Schemas for the planning calls that return JSON. They describe the
 * shape the prompts ask for. The parsers and validators still run, so a
 * schema only removes malformed output, never a semantic check.
 *
 * Anthropic allows at most 24 optional fields and 16 unions per schema, so
 * the analysis output, with far more optional fields, keeps plain JSON mode.
 */
export function responseSchemaFromZod(name: string, schema: z.ZodType): ResponseSchema {
  return { name, schema: z.toJSONSchema(schema) };
}

const sourceEvidenceSchema = z.object({ path: z.string() });

/** Kept so a model that echoes a published reference page keeps its identity. */
const pageReferenceSchema = z.object({
  kind: z.enum(["rest", "sdk"]),
  groupId: z.string().optional(),
  moduleId: z.string().optional(),
  endpointId: z.string().optional(),
});

const structurePageSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  group: z.string().optional(),
  sourceEvidence: z.array(sourceEvidenceSchema).optional(),
  collectionId: z.string().optional(),
  collectionItemId: z.string().optional(),
  reference: pageReferenceSchema.optional(),
});

const structureSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  default: z.boolean().optional(),
  pages: z.array(structurePageSchema),
});

export const STRUCTURE_RESPONSE_SCHEMA = responseSchemaFromZod(
  "documentation_structure",
  z.object({ sections: z.array(structureSectionSchema).min(1) }),
);
