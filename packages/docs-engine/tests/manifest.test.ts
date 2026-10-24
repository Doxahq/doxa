import { describe, expect, test } from "vitest";
import {
  DOCS_ARTIFACT_SCHEMA_VERSION,
  LEGACY_DOCS_ARTIFACT_SCHEMA_VERSION,
  SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS,
  createRuntimeDocsArtifacts,
  createStarterDocsManifest,
  isSupportedDocsArtifactSchemaVersion,
  parseDocsManifest,
  parseDocsManifestText,
} from "../src/index";

const baseManifest = {
  siteId: "site-1",
  versionId: "version-1",
  projectSlug: "demo",
  generatedAt: "2026-09-01T00:00:00.000Z",
  pages: [{ title: "Overview", href: "/", sourcePath: "source/index.mdx" }],
};

const unsupportedVersion = Math.max(...SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS) + 1;

describe("docs artifact schema version contract", () => {
  test("the current writer version is a supported reader version", () => {
    expect(isSupportedDocsArtifactSchemaVersion(DOCS_ARTIFACT_SCHEMA_VERSION)).toBe(
      true,
    );
    expect(SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS).toContain(
      DOCS_ARTIFACT_SCHEMA_VERSION,
    );
  });

  test("legacy manifests without a schema version stay supported", () => {
    expect(
      isSupportedDocsArtifactSchemaVersion(LEGACY_DOCS_ARTIFACT_SCHEMA_VERSION),
    ).toBe(true);
    expect(SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS[0]).toBe(
      LEGACY_DOCS_ARTIFACT_SCHEMA_VERSION,
    );
  });

  test("supported versions are contiguous from the legacy version", () => {
    const versions = [...SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS];
    expect(versions).toEqual(
      versions.map((_, index) => LEGACY_DOCS_ARTIFACT_SCHEMA_VERSION + index),
    );
  });
});

describe("parseDocsManifest", () => {
  test("reads a legacy manifest as schema version 1", () => {
    const result = parseDocsManifest(baseManifest);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.schemaVersion).toBe(1);
    expect(result.manifest.pages).toEqual(baseManifest.pages);
  });

  test("reads a manifest stamped with the current version", () => {
    const result = parseDocsManifest({
      ...baseManifest,
      schemaVersion: DOCS_ARTIFACT_SCHEMA_VERSION,
      siteConfig: { path: "settings/site.json", sha256: "a".repeat(64) },
    });

    expect(result).toMatchObject({ ok: true });
  });

  test("rejects a manifest from a newer writer with a distinct reason", () => {
    const result = parseDocsManifest({
      ...baseManifest,
      schemaVersion: unsupportedVersion,
    });

    expect(result).toEqual({
      ok: false,
      reason: "unsupported_schema_version",
      schemaVersion: unsupportedVersion,
    });
  });

  test("recognizes an unsupported version before validating its payload shape", () => {
    expect(
      parseDocsManifest({ schemaVersion: unsupportedVersion, routes: [] }),
    ).toEqual({
      ok: false,
      reason: "unsupported_schema_version",
      schemaVersion: unsupportedVersion,
    });
  });

  test.each([null, [], "manifest", 1])(
    "rejects a non-object manifest: %j",
    (input) => {
      expect(parseDocsManifest(input)).toEqual({
        ok: false,
        reason: "invalid_manifest",
      });
    },
  );

  test("rejects a malformed schema version as an invalid manifest", () => {
    expect(parseDocsManifest({ ...baseManifest, schemaVersion: 0 })).toEqual({
      ok: false,
      reason: "invalid_manifest",
    });
    expect(parseDocsManifest({ ...baseManifest, schemaVersion: "1" })).toEqual({
      ok: false,
      reason: "invalid_manifest",
    });
    expect(parseDocsManifest({ ...baseManifest, schemaVersion: 1.5 })).toEqual({
      ok: false,
      reason: "invalid_manifest",
    });
  });

  test("rejects a manifest that is missing required fields", () => {
    expect(parseDocsManifest({ siteId: "site-1" })).toEqual({
      ok: false,
      reason: "invalid_manifest",
    });
  });

  test("keeps reading a manifest that carries unknown fields", () => {
    const result = parseDocsManifest({ ...baseManifest, futureField: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("futureField" in result.manifest).toBe(false);
  });
});

describe("parseDocsManifestText", () => {
  test("separates invalid JSON from an invalid manifest", () => {
    expect(parseDocsManifestText("{not json")).toEqual({
      ok: false,
      reason: "invalid_json",
    });
    expect(parseDocsManifestText("{}")).toEqual({
      ok: false,
      reason: "invalid_manifest",
    });
  });

  test("parses the text of a valid manifest", () => {
    const result = parseDocsManifestText(JSON.stringify(baseManifest));

    expect(result).toMatchObject({ ok: true });
  });
});

describe("manifest writers", () => {
  test("the starter manifest is stamped with the current schema version", async () => {
    const manifest = await createStarterDocsManifest({
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "demo",
      projectName: "Demo",
    });

    expect(manifest.schemaVersion).toBe(DOCS_ARTIFACT_SCHEMA_VERSION);
    expect(parseDocsManifest(manifest)).toMatchObject({ ok: true });
  });

  test("generated artifact bundles write the stamped manifest to disk", async () => {
    const bundle = await createRuntimeDocsArtifacts({
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "demo",
      projectName: "Demo",
      pages: [{ title: "Overview", route: "/", content: "# Overview" }],
    });
    const manifestFile = bundle.files.find(
      (file) => file.path === "manifest.json",
    );

    expect(bundle.manifest.schemaVersion).toBe(DOCS_ARTIFACT_SCHEMA_VERSION);
    expect(manifestFile).toBeDefined();
    expect(parseDocsManifestText(manifestFile!.content)).toEqual({
      ok: true,
      manifest: bundle.manifest,
    });
  });
});
