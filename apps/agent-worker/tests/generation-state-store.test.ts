import {
  GENERATION_STATE_SCHEMA_VERSION,
  type GenerationAnalysisState,
  type GenerationPageState,
  type GenerationSourceState,
  type GenerationStructureState,
} from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import {
  GenerationStateStore,
  generationStateManifestKey,
  generationStatePrefix,
  type GenerationStateStorage,
  type GenerationStateStorageObject,
  type WritePermanentGenerationStateInput,
} from "../src/generation-state-store";

const SITE_ID = "site-1";
const VERSION_ID = "version-1";
const SOURCE_REVISION = "a".repeat(40);
const SOURCE_TREE_HASH = "b".repeat(40);
const CONTENT_HASH = "c".repeat(64);
const ANALYSIS_HASH = "d".repeat(64);
const STRUCTURE_HASH = "e".repeat(64);
const FINGERPRINT = "f".repeat(64);

describe("permanent generation-state store", () => {
  test("round-trips validated reusable state", async () => {
    const storage = new MemoryGenerationStateStorage();
    const store = new GenerationStateStore(storage);
    const input = generationStateInput();

    const manifest = await store.write(input);
    const loaded = await store.load(SITE_ID, VERSION_ID);

    expect(manifest.generatorFingerprint).toBe("doxabot-v1");
    expect(manifest.planningFingerprint).toBe("planning-v1");
    expect(manifest.writingFingerprint).toBe("writing-v1");
    expect(manifest.pages.map((page) => page.pageId)).toEqual([
      "guide",
      "overview",
    ]);
    expect(loaded).toEqual({
      outcome: "available",
      state: {
        manifest,
        source: input.source,
        analysis: input.analysis,
        structure: input.structure,
        pages: [input.pages[1], input.pages[0]],
      },
    });
  });

  test("treats an absent manifest as an unavailable baseline", async () => {
    const store = new GenerationStateStore(
      new MemoryGenerationStateStorage(),
    );

    await expect(store.load(SITE_ID, "missing-version")).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "missing_manifest",
    });
  });

  test("rejects corrupt manifest JSON", async () => {
    const storage = new MemoryGenerationStateStorage();
    storage.set(generationStateManifestKey(SITE_ID, VERSION_ID), "{broken");
    const store = new GenerationStateStore(storage);

    await expect(store.load(SITE_ID, VERSION_ID)).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "corrupt_manifest",
    });
  });

  test("returns incompatible for unsupported manifest versions", async () => {
    const storage = new MemoryGenerationStateStorage();
    storage.set(
      generationStateManifestKey(SITE_ID, VERSION_ID),
      JSON.stringify({ schemaVersion: 99 }),
    );
    const store = new GenerationStateStore(storage);

    await expect(store.load(SITE_ID, VERSION_ID)).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "incompatible_schema",
    });
  });

  test("does not expose artifact writes without a completion manifest", async () => {
    const storage = new MemoryGenerationStateStorage();
    const store = new GenerationStateStore(storage);
    const manifestKey = generationStateManifestKey(SITE_ID, VERSION_ID);
    storage.failNextWrite(manifestKey);

    await expect(store.write(generationStateInput())).rejects.toThrow(
      "Injected immutable-write failure",
    );
    expect(storage.keys()).toContain(
      `${generationStatePrefix(SITE_ID, VERSION_ID)}/source.json`,
    );
    await expect(store.load(SITE_ID, VERSION_ID)).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "missing_manifest",
    });

    await expect(store.write(generationStateInput())).resolves.toMatchObject({
      versionId: VERSION_ID,
    });
    await expect(store.load(SITE_ID, VERSION_ID)).resolves.toMatchObject({
      outcome: "available",
    });
  });

  test("rejects a referenced object with the wrong hash", async () => {
    const storage = new MemoryGenerationStateStorage();
    const store = new GenerationStateStore(storage);
    const manifest = await store.write(generationStateInput());
    storage.set(manifest.analysis.key, "{\"tampered\":true}\n");

    await expect(store.load(SITE_ID, VERSION_ID)).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "hash_mismatch",
    });
  });

  test("rejects references outside the version prefix", async () => {
    const storage = new MemoryGenerationStateStorage();
    const store = new GenerationStateStore(storage);
    await store.write(generationStateInput());
    const manifestKey = generationStateManifestKey(SITE_ID, VERSION_ID);
    const manifest = storage.json(manifestKey);
    storage.set(
      manifestKey,
      `${JSON.stringify({
        ...manifest,
        source: {
          key: "sites/other/generation-state/version-9/source.json",
          hash: "0".repeat(64),
        },
      })}\n`,
    );

    await expect(store.load(SITE_ID, VERSION_ID)).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "wrong_prefix",
    });
  });

  test("rejects a missing referenced object", async () => {
    const storage = new MemoryGenerationStateStorage();
    const store = new GenerationStateStore(storage);
    const manifest = await store.write(generationStateInput());
    storage.delete(manifest.structure.key);

    await expect(store.load(SITE_ID, VERSION_ID)).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "missing_object",
    });
  });

  test("rejects immutable version keys with different content", async () => {
    const storage = new MemoryGenerationStateStorage();
    const store = new GenerationStateStore(storage);
    await store.write(generationStateInput());
    const changed = generationStateInput();
    changed.analysis = {
      ...changed.analysis,
      analysis: { projectName: "Another project" },
    };

    await expect(store.write(changed)).rejects.toThrow(
      "Immutable generation-state object already exists with different content",
    );
  });
});

class MemoryGenerationStateStorage implements GenerationStateStorage {
  private readonly objects = new Map<string, string>();
  private readonly failingWrites = new Set<string>();

  async read(key: string): Promise<GenerationStateStorageObject | null> {
    const value = this.objects.get(key);
    if (value === undefined) {
      return null;
    }
    return {
      size: new TextEncoder().encode(value).byteLength,
      async text() {
        return value;
      },
    };
  }

  async writeImmutable(
    key: string,
    value: string,
  ): Promise<"written" | "exists"> {
    if (this.failingWrites.delete(key)) {
      throw new Error("Injected immutable-write failure.");
    }
    if (this.objects.has(key)) {
      return "exists";
    }
    this.objects.set(key, value);
    return "written";
  }

  set(key: string, value: string): void {
    this.objects.set(key, value);
  }

  delete(key: string): void {
    this.objects.delete(key);
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  failNextWrite(key: string): void {
    this.failingWrites.add(key);
  }

  json(key: string): Record<string, unknown> {
    const value = this.objects.get(key);
    if (!value) {
      throw new Error(`Missing in-memory object: ${key}`);
    }
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw new Error(`Expected an object at ${key}`);
    }
    return parsed;
  }
}

function generationStateInput(): WritePermanentGenerationStateInput {
  return {
    siteId: SITE_ID,
    versionId: VERSION_ID,
    baselineVersionId: "version-0",
    generatorFingerprint: "doxabot-v1",
    planningFingerprint: "planning-v1",
    writingFingerprint: "writing-v1",
    source: sourceState(),
    analysis: analysisState(),
    structure: structureState(),
    pages: [
      pageState("overview", "/"),
      pageState("guide", "/guide"),
    ],
    createdAt: "2026-07-23T12:00:00.000Z",
  };
}

function sourceState(): GenerationSourceState {
  return {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    sourceRevision: SOURCE_REVISION,
    sourceTreeHash: SOURCE_TREE_HASH,
    files: [
      {
        path: "src/index.ts",
        contentHash: CONTENT_HASH,
        contentKind: "text",
      },
    ],
  };
}

function analysisState(): GenerationAnalysisState {
  return {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    analysis: { projectName: "Doxa" },
    analysisHash: ANALYSIS_HASH,
    sourceSummaries: [
      {
        path: "src/index.ts",
        contentHash: CONTENT_HASH,
        summary: { exports: ["createApp"] },
      },
    ],
  };
}

function structureState(): GenerationStructureState {
  return {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    structure: { pageIds: ["overview", "guide"] },
    structureHash: STRUCTURE_HASH,
    structuralFingerprint: FINGERPRINT,
  };
}

function pageState(pageId: string, route: string): GenerationPageState {
  return {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    pageId,
    title: pageId === "overview" ? "Overview" : "Guide",
    route,
    navigationPath: `default/${pageId}.md`,
    artifactKey:
      `sites/${SITE_ID}/versions/${VERSION_ID}/default/${pageId}.md`,
    contentHash: CONTENT_HASH,
    pageInputHash: FINGERPRINT,
    dependencies: {
      sourceFilesRead: ["src/index.ts"],
      sourceFilesDiscovered: [],
      sourceEvidenceFiles: ["src/index.ts"],
      referencedSymbols: ["createApp"],
      referencedRoutes: [route],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
