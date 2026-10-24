import { z } from "zod";
import { sha256Schema } from "@doxahq/contracts/docs-prerender";
import {
  docsArtifactSchemaVersionSchema,
  isSupportedDocsArtifactSchemaVersion,
} from "./artifact-schema";

export const docsManifestPageSchema = z.object({
  title: z.string(),
  href: z.string(),
  sourcePath: z.string(),
});

const docsManifestVersionSchema = z.object({
  schemaVersion: docsArtifactSchemaVersionSchema,
});

/**
 * The published manifest of one immutable artifact set.
 *
 * Unknown keys are stripped, not rejected, so a manifest written with extra
 * fields by a newer writer still parses on an older reader. The renderer
 * must keep this schema readable for every version it ever published.
 */
export const docsManifestV1Schema = z.object({
  schemaVersion: z.literal(1).default(1),
  siteId: z.string(),
  versionId: z.string(),
  projectSlug: z.string(),
  generatedAt: z.string(),
  pages: z.array(docsManifestPageSchema),
});

export const docsManifestV2Schema = docsManifestV1Schema.extend({
  schemaVersion: z.literal(2),
  siteConfig: z.object({
    path: z.literal("settings/site.json"),
    sha256: sha256Schema,
  }),
});

export const docsManifestSchema = z.discriminatedUnion("schemaVersion", [
  docsManifestV1Schema,
  docsManifestV2Schema,
]);

export type DocsManifestV1 = z.infer<typeof docsManifestV1Schema>;
export type DocsManifestV2 = z.infer<typeof docsManifestV2Schema>;

export type DocsManifest = z.infer<typeof docsManifestSchema>;
export type DocsManifestPage = z.infer<typeof docsManifestPageSchema>;

export type DocsManifestParseFailureReason =
  | "invalid_json"
  | "invalid_manifest"
  | "unsupported_schema_version";

export type DocsManifestParseResult =
  | { ok: true; manifest: DocsManifest }
  | { ok: false; reason: "invalid_json" | "invalid_manifest" }
  | { ok: false; reason: "unsupported_schema_version"; schemaVersion: number };

/**
 * Parses a manifest and checks that the current reader supports its schema
 * version. Every reader must go through this function so that a manifest
 * from a newer writer fails with `unsupported_schema_version` instead of
 * rendering with the wrong assumptions.
 */
export function parseDocsManifest(input: unknown): DocsManifestParseResult {
  // A newer version can change required fields. Identify it before applying
  // the current payload schema so deploy-order errors stay distinguishable.
  const version = docsManifestVersionSchema.safeParse(input);
  if (!version.success) {
    return { ok: false, reason: "invalid_manifest" };
  }

  const { schemaVersion } = version.data;
  if (!isSupportedDocsArtifactSchemaVersion(schemaVersion)) {
    return { ok: false, reason: "unsupported_schema_version", schemaVersion };
  }

  const schema =
    schemaVersion === 1 ? docsManifestV1Schema : docsManifestV2Schema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_manifest" };
  }

  return { ok: true, manifest: parsed.data };
}

/** Parses the raw text of a `manifest.json` object. */
export function parseDocsManifestText(raw: string): DocsManifestParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  return parseDocsManifest(json);
}
