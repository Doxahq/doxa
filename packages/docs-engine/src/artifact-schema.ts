import { z } from "zod";

/**
 * Docs artifact schema versioning.
 *
 * One artifact set (`manifest.json`, `settings/**`, `source/**`, `search/**`)
 * is written once at publish time and then read forever by an evergreen
 * renderer. The schema version is the contract between the two sides:
 *
 * - Writers (the docs engine, the API publish paths, the generation
 *   pipeline) stamp `DOCS_ARTIFACT_SCHEMA_VERSION` into the manifest.
 * - Readers (the docs runtime, the API content service, the generation
 *   validator) accept every version listed in
 *   `SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS` and reject anything newer with
 *   a distinct, loud failure instead of a silent mis-render.
 *
 * A breaking change to the artifact shape must add a new version here, keep
 * every older version readable, and add a frozen fixture set for the new
 * version. See `docs/current/docs-artifact-compatibility.md`.
 */

/** The schema version every writer stamps into new manifests. */
export const DOCS_ARTIFACT_SCHEMA_VERSION = 2;

/**
 * Manifests written before the field existed carry no `schemaVersion`. They
 * are schema version 1 by definition and must stay readable.
 */
export const LEGACY_DOCS_ARTIFACT_SCHEMA_VERSION = 1;

/**
 * Every schema version the current readers can render. Only append to this
 * list. Removing a version breaks every site still published with it.
 * Readers can support versions newer than DOCS_ARTIFACT_SCHEMA_VERSION so
 * they can deploy before writers start producing the new format.
 */
export const SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS = [1, 2] as const;

export type DocsArtifactSchemaVersion =
  (typeof SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS)[number];

/**
 * Accepts any positive integer so that a manifest written by a newer writer
 * still parses as a manifest. Support is checked separately, so the reader
 * can report "unsupported version" instead of "invalid manifest".
 */
export const docsArtifactSchemaVersionSchema = z
  .number()
  .int()
  .positive()
  .default(LEGACY_DOCS_ARTIFACT_SCHEMA_VERSION);

export function isSupportedDocsArtifactSchemaVersion(
  version: number,
): version is DocsArtifactSchemaVersion {
  return (
    SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS as readonly number[]
  ).includes(version);
}
