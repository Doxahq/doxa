import {
  GENERATION_STATE_SCHEMA_VERSION,
  generationAnalysisStateSchema,
  generationPageStateSchema,
  generationSourceStateSchema,
  generationStateManifestSchema,
  generationStructureStateSchema,
  type GenerationAnalysisState,
  type GenerationPageState,
  type GenerationSourceState,
  type GenerationStateManifest,
  type GenerationStructureState,
} from "@doxahq/contracts";

const MAX_STATE_OBJECT_BYTES = 5 * 1024 * 1024;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface GenerationStateStorageObject {
  readonly size: number;
  text(): Promise<string>;
}

export interface GenerationStateStorage {
  read(key: string): Promise<GenerationStateStorageObject | null>;
  writeImmutable(key: string, value: string): Promise<"written" | "exists">;
}

export interface PermanentGenerationState {
  manifest: GenerationStateManifest;
  source: GenerationSourceState;
  analysis: GenerationAnalysisState;
  structure: GenerationStructureState;
  pages: GenerationPageState[];
}

export interface WritePermanentGenerationStateInput {
  siteId: string;
  versionId: string;
  baselineVersionId: string | null;
  generatorFingerprint: string;
  planningFingerprint: string;
  writingFingerprint: string;
  source: GenerationSourceState;
  analysis: GenerationAnalysisState;
  structure: GenerationStructureState;
  pages: GenerationPageState[];
  createdAt: string;
}

export type GenerationStateUnavailableReason =
  | "missing_manifest"
  | "incompatible_schema"
  | "corrupt_manifest"
  | "wrong_identity"
  | "wrong_prefix"
  | "missing_object"
  | "invalid_object"
  | "hash_mismatch";

export type LoadPermanentGenerationStateResult =
  | {
      outcome: "available";
      state: PermanentGenerationState;
    }
  | {
      outcome: "unavailable";
      reason: GenerationStateUnavailableReason;
      message: string;
    };

export class GenerationStateStore {
  constructor(private readonly storage: GenerationStateStorage) {}

  async write(
    input: WritePermanentGenerationStateInput,
  ): Promise<GenerationStateManifest> {
    assertKeySegment(input.siteId, "site ID");
    assertKeySegment(input.versionId, "version ID");
    if (input.baselineVersionId) {
      assertKeySegment(input.baselineVersionId, "baseline version ID");
    }
    const source = generationSourceStateSchema.parse(input.source);
    const analysis = generationAnalysisStateSchema.parse(input.analysis);
    const structure = generationStructureStateSchema.parse(input.structure);
    const pages = input.pages
      .map((page) => generationPageStateSchema.parse(page))
      .sort((left, right) => compareStrings(left.pageId, right.pageId));
    assertUniquePageIds(pages);
    if (
      source.sourceRevision !== input.source.sourceRevision ||
      source.sourceTreeHash !== input.source.sourceTreeHash
    ) {
      throw new Error("Generation source state identity is invalid.");
    }

    const prefix = generationStatePrefix(input.siteId, input.versionId);
    const sourceReference = await this.writeStateObject(
      `${prefix}/source.json`,
      source,
    );
    const analysisReference = await this.writeStateObject(
      `${prefix}/analysis.json`,
      analysis,
    );
    const structureReference = await this.writeStateObject(
      `${prefix}/structure.json`,
      structure,
    );
    const manifestPages: GenerationStateManifest["pages"] = [];
    for (const page of pages) {
      const pageKey = `${prefix}/pages/${await sha256Hex(page.pageId)}.json`;
      const record = await this.writeStateObject(pageKey, page);
      manifestPages.push({
        pageId: page.pageId,
        record,
        artifactKey: page.artifactKey,
        contentHash: page.contentHash,
      });
    }

    const manifest = generationStateManifestSchema.parse({
      schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
      siteId: input.siteId,
      versionId: input.versionId,
      baselineVersionId: input.baselineVersionId,
      generatorFingerprint: input.generatorFingerprint,
      planningFingerprint: input.planningFingerprint,
      writingFingerprint: input.writingFingerprint,
      sourceRevision: source.sourceRevision,
      sourceTreeHash: source.sourceTreeHash,
      source: sourceReference,
      analysis: analysisReference,
      structure: structureReference,
      pages: manifestPages,
      createdAt: input.createdAt,
    });
    await this.writeStateObject(
      generationStateManifestKey(input.siteId, input.versionId),
      manifest,
    );
    return manifest;
  }

  async load(
    siteId: string,
    versionId: string,
  ): Promise<LoadPermanentGenerationStateResult> {
    assertKeySegment(siteId, "site ID");
    assertKeySegment(versionId, "version ID");
    try {
      return await this.loadValidated(siteId, versionId);
    } catch {
      return unavailable(
        "invalid_object",
        "Published generation state could not be read safely.",
      );
    }
  }

  private async loadValidated(
    siteId: string,
    versionId: string,
  ): Promise<LoadPermanentGenerationStateResult> {
    const prefix = generationStatePrefix(siteId, versionId);
    const manifestObject = await this.storage.read(
      generationStateManifestKey(siteId, versionId),
    );
    if (!manifestObject) {
      return unavailable(
        "missing_manifest",
        "Published generation state has no completion manifest.",
      );
    }
    const manifestText = await readBoundedText(manifestObject);
    const rawManifest = parseJson(manifestText);
    if (!rawManifest.ok) {
      return unavailable(
        "corrupt_manifest",
        "Published generation-state manifest is not valid JSON.",
      );
    }
    if (
      isRecord(rawManifest.value) &&
      rawManifest.value.schemaVersion !== GENERATION_STATE_SCHEMA_VERSION
    ) {
      return unavailable(
        "incompatible_schema",
        "Published generation state uses an unsupported schema version.",
      );
    }
    const parsedManifest = generationStateManifestSchema.safeParse(
      rawManifest.value,
    );
    if (!parsedManifest.success) {
      return unavailable(
        "corrupt_manifest",
        "Published generation-state manifest is invalid.",
      );
    }
    const manifest = parsedManifest.data;
    if (manifest.siteId !== siteId || manifest.versionId !== versionId) {
      return unavailable(
        "wrong_identity",
        "Published generation-state manifest belongs to another version.",
      );
    }

    const references = [
      manifest.source,
      manifest.analysis,
      manifest.structure,
      ...manifest.pages.map((page) => page.record),
    ];
    if (
      references.some(
        (reference) =>
          !reference.key.startsWith(`${prefix}/`) ||
          reference.key === `${prefix}/`,
      )
    ) {
      return unavailable(
        "wrong_prefix",
        "Published generation state references another storage prefix.",
      );
    }

    const source = await this.readReferencedState(
      manifest.source,
      generationSourceStateSchema,
    );
    if (source.outcome === "unavailable") {
      return source;
    }
    const analysis = await this.readReferencedState(
      manifest.analysis,
      generationAnalysisStateSchema,
    );
    if (analysis.outcome === "unavailable") {
      return analysis;
    }
    const structure = await this.readReferencedState(
      manifest.structure,
      generationStructureStateSchema,
    );
    if (structure.outcome === "unavailable") {
      return structure;
    }
    const pages: GenerationPageState[] = [];
    for (const manifestPage of manifest.pages) {
      const page = await this.readReferencedState(
        manifestPage.record,
        generationPageStateSchema,
      );
      if (page.outcome === "unavailable") {
        return page;
      }
      if (
        page.value.pageId !== manifestPage.pageId ||
        page.value.artifactKey !== manifestPage.artifactKey ||
        page.value.contentHash !== manifestPage.contentHash
      ) {
        return unavailable(
          "wrong_identity",
          `Generation-state page ${manifestPage.pageId} does not match its manifest entry.`,
        );
      }
      pages.push(page.value);
    }
    if (
      source.value.sourceRevision !== manifest.sourceRevision ||
      source.value.sourceTreeHash !== manifest.sourceTreeHash
    ) {
      return unavailable(
        "wrong_identity",
        "Generation source state does not match its manifest identity.",
      );
    }

    return {
      outcome: "available",
      state: {
        manifest,
        source: source.value,
        analysis: analysis.value,
        structure: structure.value,
        pages,
      },
    };
  }

  private async writeStateObject(
    key: string,
    value: unknown,
  ): Promise<{ key: string; hash: string }> {
    const serialized = `${JSON.stringify(value)}\n`;
    const hash = await sha256Hex(serialized);
    const outcome = await this.storage.writeImmutable(key, serialized);
    if (outcome === "exists") {
      const existing = await this.storage.read(key);
      if (!existing || await readBoundedText(existing) !== serialized) {
        throw new Error(
          `Immutable generation-state object already exists with different content: ${key}`,
        );
      }
    }
    return { key, hash };
  }

  private async readReferencedState<T>(
    reference: { key: string; hash: string },
    schema: {
      safeParse(value: unknown):
        | { success: true; data: T }
        | { success: false };
    },
  ): Promise<
    | { outcome: "available"; value: T }
    | Extract<LoadPermanentGenerationStateResult, { outcome: "unavailable" }>
  > {
    const object = await this.storage.read(reference.key);
    if (!object) {
      return unavailable(
        "missing_object",
        `Published generation-state object is missing: ${reference.key}`,
      );
    }
    const text = await readBoundedText(object);
    if (await sha256Hex(text) !== reference.hash) {
      return unavailable(
        "hash_mismatch",
        `Published generation-state object failed integrity validation: ${reference.key}`,
      );
    }
    const raw = parseJson(text);
    if (!raw.ok) {
      return unavailable(
        "invalid_object",
        `Published generation-state object is not valid JSON: ${reference.key}`,
      );
    }
    if (
      isRecord(raw.value) &&
      raw.value.schemaVersion !== GENERATION_STATE_SCHEMA_VERSION
    ) {
      return unavailable(
        "incompatible_schema",
        `Published generation-state object uses an unsupported schema version: ${reference.key}`,
      );
    }
    const parsed = schema.safeParse(raw.value);
    if (!parsed.success) {
      return unavailable(
        "invalid_object",
        `Published generation-state object is invalid: ${reference.key}`,
      );
    }
    return { outcome: "available", value: parsed.data };
  }
}

export function createR2GenerationStateStorage(
  bucket: R2Bucket,
): GenerationStateStorage {
  return {
    async read(key) {
      const object = await bucket.get(key);
      if (!object) {
        return null;
      }
      return {
        size: object.size,
        text: () => object.text(),
      };
    },
    async writeImmutable(key, value) {
      const object = await bucket.put(key, value, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: JSON_CONTENT_TYPE },
      });
      return object ? "written" : "exists";
    },
  };
}

export function generationStatePrefix(
  siteId: string,
  versionId: string,
): string {
  assertKeySegment(siteId, "site ID");
  assertKeySegment(versionId, "version ID");
  return `sites/${siteId}/generation-state/${versionId}`;
}

export function generationStateManifestKey(
  siteId: string,
  versionId: string,
): string {
  return `${generationStatePrefix(siteId, versionId)}/manifest.json`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readBoundedText(
  object: GenerationStateStorageObject,
): Promise<string> {
  if (object.size > MAX_STATE_OBJECT_BYTES) {
    throw new Error("Generation-state object exceeds the supported size limit.");
  }
  return object.text();
}

function parseJson(
  value: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function unavailable(
  reason: GenerationStateUnavailableReason,
  message: string,
): Extract<LoadPermanentGenerationStateResult, { outcome: "unavailable" }> {
  return { outcome: "unavailable", reason, message };
}

function assertKeySegment(value: string, name: string): void {
  if (!SAFE_KEY_SEGMENT.test(value)) {
    throw new Error(`Generation-state ${name} is invalid.`);
  }
}

function assertUniquePageIds(pages: readonly GenerationPageState[]): void {
  for (let index = 1; index < pages.length; index += 1) {
    if (pages[index - 1].pageId === pages[index].pageId) {
      throw new Error(
        `Duplicate generation-state page ID: ${pages[index].pageId}`,
      );
    }
  }
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
