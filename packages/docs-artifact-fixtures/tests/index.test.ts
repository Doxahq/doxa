import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DOCS_ARTIFACT_SCHEMA_VERSION,
  LEGACY_DOCS_ARTIFACT_SCHEMA_VERSION,
  SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS,
} from "@doxahq/docs-engine";
import {
  listFrozenArtifactSets,
  loadFrozenArtifactSetByName,
  routeDataSnapshotFileName,
} from "../src/index";

const sets = listFrozenArtifactSets();

describe("ARTIFACT COMPATIBILITY GATE: frozen set inventory", () => {
  test("every supported schema version has at least one frozen set", () => {
    const frozenVersions = new Set(sets.map((set) => set.schemaVersion));

    for (const version of SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS) {
      expect(frozenVersions.has(version), `schema version ${version}`).toBe(
        true,
      );
    }
  });

  test("the current writer version has a frozen set", () => {
    expect(
      sets.some((set) => set.schemaVersion === DOCS_ARTIFACT_SCHEMA_VERSION),
    ).toBe(true);
  });

  test("a legacy set without a schemaVersion field is frozen", () => {
    const legacy = loadFrozenArtifactSetByName(
      LEGACY_DOCS_ARTIFACT_SCHEMA_VERSION,
      "legacy-unversioned",
    );
    const rawManifest = JSON.parse(legacy.objects[legacy.manifestPath]!);

    expect("schemaVersion" in rawManifest).toBe(false);
    expect(legacy.manifest.schemaVersion).toBe(
      LEGACY_DOCS_ARTIFACT_SCHEMA_VERSION,
    );
  });

  test("set names are unique across schema versions", () => {
    const names = sets.map((set) => `${set.schemaVersion}:${set.name}`);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe.each(sets)(
  "ARTIFACT COMPATIBILITY GATE: frozen set $name (schema v$schemaVersion)",
  (set) => {
    test("declares a supported schema version", () => {
      expect(SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS).toContain(
        set.schemaVersion,
      );
    });

    test("pins the manifest to its own site and version", () => {
      expect(set.manifest.siteId).toBe(set.siteId);
      expect(set.manifest.versionId).toBe(set.versionId);
      expect(set.manifest.projectSlug).toBe(set.projectSlug);
      expect(set.resolution.artifactPrefix).toBe(set.artifactPrefix);
      expect(set.resolution.manifestPath).toBe(set.manifestPath);
    });

    test("stores every artifact under the pinned artifact prefix", () => {
      for (const key of Object.keys(set.objects)) {
        expect(key.startsWith(`${set.artifactPrefix}/`)).toBe(true);
      }
    });

    test("has a source object for every manifest page", () => {
      for (const page of set.manifest.pages) {
        expect(
          set.objects[`${set.artifactPrefix}/${page.sourcePath}`],
          page.sourcePath,
        ).toBeDefined();
      }
    });

    test("has the settings and search artifacts of its schema version", () => {
      for (const relativePath of [
        "settings/sections.json",
        "settings/documents.json",
        "search/index.json",
        "search/minisearch.json",
      ]) {
        expect(
          set.objects[`${set.artifactPrefix}/${relativePath}`],
          relativePath,
        ).toBeDefined();
      }
    });

    test("has a golden route data file for every manifest page", () => {
      for (const page of set.manifest.pages) {
        expect(
          existsSync(set.expectedRouteDataPath(page.href)),
          `missing golden for ${page.href}; run the docs-runtime compatibility test to create it`,
        ).toBe(true);
      }
    });
  },
);

describe("routeDataSnapshotFileName", () => {
  test("maps hrefs to stable file names", () => {
    expect(routeDataSnapshotFileName("/")).toBe("index.json");
    expect(routeDataSnapshotFileName("/quickstart")).toBe("quickstart.json");
    expect(routeDataSnapshotFileName("/api/messages/create")).toBe(
      "api__messages__create.json",
    );
  });
});
