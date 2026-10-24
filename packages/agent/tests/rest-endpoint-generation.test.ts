import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type {
  AgentConfig,
  AgentProgressEvent,
  AgentUsageRecord,
  ChatRequest,
  ChatResponse,
  ConcurrencyLimiter,
  DocumentationStructure,
  GeneratedPageContent,
  Provider,
  RestApiReferenceEndpoint,
  WriterContext,
} from "../src";
import {
  baselinePageInputHashes,
  buildPageInputHashMap,
  generateDocumentation,
} from "../src/doxa-agent/generation-service";
import { flattenStructure, stablePageId } from "../src/doxa-agent/structure-utils";
import { hashObject } from "../src/utils/hash";
import { runPageValidation } from "../src/utils/page-validator";
import { analysisFixture } from "./fixtures";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

const createFlag: RestApiReferenceEndpoint = {
  id: "create-flag",
  title: "Create a flag",
  method: "POST",
  path: "/flags",
  description: "Create a feature flag and return the stored flag record.",
  bodyFields: [{ name: "key", type: "string", required: true, description: "Unique flag key." }],
  bodyContentType: "application/json",
  responses: [{ status: 201, example: '{\n  "key": "new-checkout"\n}' }],
  sourceEvidence: [{ path: "src/routes/flags.ts" }],
};

// The endpoint page comes first, so the first finished page made no model call.
const structure: DocumentationStructure = {
  sections: [
    {
      id: "api",
      title: "REST API",
      pages: [{
        id: "create-flag",
        title: "Create a flag",
        description: "Create a feature flag and return the stored flag record.",
        sourceEvidence: createFlag.sourceEvidence,
        audience: "reference",
        reference: {
          kind: "rest",
          pageKind: "endpoint",
          groupId: "flags",
          endpointId: "create-flag",
          method: "POST",
          path: "/flags",
        },
      }],
    },
    {
      id: "guides",
      title: "Guides",
      default: true,
      pages: [{
        id: "rollouts",
        title: "Rollouts",
        description: "Roll out a feature flag to a share of users.",
        sourceEvidence: [{ path: "src/rollouts.ts" }],
      }],
    },
  ],
};

const writerContext: WriterContext = {
  analysis: {
    ...analysisFixture,
    referenceSurfaces: {
      rest: {
        label: "REST API",
        slug: "rest-api",
        baseUrl: "https://api.example.com",
        sourceEvidence: [],
        groups: [{
          id: "flags",
          title: "Flags",
          sourceEvidence: [],
          endpoints: [createFlag],
        }],
      },
    },
  },
  answers: {},
  structure,
};

function guidePage(): string {
  return [
    "---",
    "title: Rollouts",
    "description: Roll out a feature flag to a share of users.",
    "---",
    "",
    "Roll out a flag to a share of users and widen the share in steps.",
    "Each step keeps the users of the previous step, so a user never loses",
    "the new behavior while the rollout grows to the full user base.",
    "Stop the rollout at any step to keep the current share while you check",
    "the metrics, then continue when the new behavior works as you expect.",
  ].join("\n");
}

function recordingProvider(requests: ChatRequest[]): Provider {
  return {
    config: { baseUrl: "https://example.test", apiKey: "test", model: "test-model" },
    async chat(request): Promise<ChatResponse> {
      requests.push(request);
      return {
        message: { role: "assistant", content: guidePage() },
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
    async *chatStream() {
      throw new Error("Streaming is not used by this test.");
    },
  };
}

async function projectRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "doxa-rest-template-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("REST endpoint pages in the page loop", () => {
  test("renders endpoint pages with no model call while guides use the writer", async () => {
    const requests: ChatRequest[] = [];
    const usage: AgentUsageRecord[] = [];
    const checkpoints: GeneratedPageContent[] = [];
    const progress: AgentProgressEvent[] = [];
    const config: AgentConfig = {
      cwd: await projectRoot(),
      outputDir: "generated",
      toolPolicy: "read_only",
      provider: recordingProvider(requests),
      concurrency: 2,
      writerValidation: { maxAttempts: 1, mdxCompile: false, timeoutMs: 10_000 },
      onModelUsage: (record) => {
        usage.push(record);
      },
      onPageGenerated: (page) => {
        checkpoints.push(page);
      },
    };

    const result = await generateDocumentation(
      config,
      structure,
      (event) => progress.push(event),
      writerContext,
      undefined,
      undefined,
      { finalize: false },
    );

    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages)).toContain("Rollouts");
    expect(usage.map((record) => record.context?.pageId)).toEqual(["guides/rollouts"]);

    expect(checkpoints.map((page) => page.id).sort()).toEqual([
      "api/create-flag",
      "guides/rollouts",
    ]);
    const endpointPage = result.pages.find((page) => page.id === "api/create-flag");
    expect(endpointPage).toBeDefined();
    if (!endpointPage) return;
    expect(endpointPage.content).toContain('<ApiEndpoint method="POST" path="/flags"');
    expect(endpointPage.content).toContain(createFlag.description);
    expect(await readFile(endpointPage.path, "utf-8")).toBe(endpointPage.content);
    expect(endpointPage.pageInputHash).toBe(
      buildPageInputHashMap(structure)["api/create-flag"],
    );
    expect(endpointPage.dependencies).toMatchObject({
      sourceFilesRead: [],
      sourceFilesDiscovered: [],
      sourceEvidenceFiles: ["src/routes/flags.ts"],
      referencedRoutes: ["/flags"],
    });
    await expect(runPageValidation(endpointPage.content, {
      preserveTitle: true,
      restEndpointPage: true,
    })).resolves.toEqual({ ok: true, issues: [] });

    const writing = progress
      .filter((event) => event.stage === "writing" && event.message.startsWith("Writing:"))
      .map((event) => event.message);
    expect(writing).toHaveLength(2);
    expect(writing.some((message) => message.includes("Create a flag"))).toBe(true);
    expect(result.qualityReport?.ok).toBe(true);
  });

  test("renders endpoint pages outside the model writer slots", async () => {
    let acquiredSlots = 0;
    const limiter: ConcurrencyLimiter = {
      width: 1,
      max: 1,
      active: 0,
      acquire: async () => {
        acquiredSlots += 1;
        return () => undefined;
      },
      recordSuccess: () => undefined,
      recordThrottle: () => undefined,
    };
    const requests: ChatRequest[] = [];

    const result = await generateDocumentation(
      {
        cwd: await projectRoot(),
        outputDir: "generated",
        toolPolicy: "read_only",
        provider: recordingProvider(requests),
        concurrency: 1,
        pageWriterLimiter: limiter,
        writerValidation: { maxAttempts: 1, mdxCompile: false, timeoutMs: 10_000 },
      },
      structure,
      undefined,
      writerContext,
      undefined,
      undefined,
      { finalize: false },
    );

    expect(result.pages.map((page) => page.id).sort()).toEqual([
      "api/create-flag",
      "guides/rollouts",
    ]);
    // Only the guide page, which calls the model, holds a slot.
    expect(acquiredSlots).toBe(1);
    expect(requests).toHaveLength(1);
  });

  test("keys template pages apart from model-written pages and still reads earlier baselines", () => {
    const hashes = buildPageInputHashMap(structure);
    const legacyHash = (index: number): string => {
      const target = flattenStructure(structure)[index];
      if (!target) throw new Error(`Missing target ${index}`);
      return hashObject({
        pageId: stablePageId(target),
        sectionTitle: target.sectionTitle,
        title: target.page.title,
        description: target.page.description,
        outputPath: target.path,
        group: target.page.group,
        sourceEvidence: target.page.sourceEvidence ?? [],
        collectionId: target.page.collectionId,
        collectionItemId: target.page.collectionItemId,
        reference: target.page.reference,
      });
    };

    const baseline = baselinePageInputHashes(structure, {
      "api/create-flag": legacyHash(0),
      "guides/rollouts": legacyHash(1),
    });

    // A template page never stands in for the page that the model writer stored.
    expect(baseline["api/create-flag"]).not.toBe(hashes["api/create-flag"]);
    // A model-written page stored under the earlier rule still matches.
    expect(baseline["guides/rollouts"]).toBe(hashes["guides/rollouts"]);
  });
});
