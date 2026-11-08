import {
  GENERATION_STATE_SCHEMA_VERSION,
  emptyPageDependencyState,
  type GenerationExecutionContext,
  type GenerationPageState,
  type IncrementalGenerationPlan,
  type StagedRuntimePage,
} from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import {
  assembleIncrementalPages,
  createProductionCompletionInput,
  isRevisionAwareProductionContext,
  isAcceptedPullRequestRevision,
  materializeReusablePage,
  resolveGenerationCheckoutSpec,
  resolvePreviewExecutionConfig,
  modelForGenerationStage,
} from "../src/generation-workflow";
import { sha256Hex } from "../src/generation-state-store";
import { planWithFailedPages } from "../src/generation-page-failures";

const hash = "a".repeat(64);

describe("incremental preview workflow invariants", () => {
  test("assembles a no-impact preview entirely from validated reuse", () => {
    const reused = [page("overview"), page("guide")];
    const result = assembleIncrementalPages(
      ["overview", "guide"],
      [],
      reused,
      plan([], ["overview", "guide"]),
    );

    expect(result).toEqual(reused);
  });

  test("assembles a site without a failed new page and with the published copy of a failed page", () => {
    const failed = [
      { id: "guide", title: "Guide", reason: "Overloaded" },
      { id: "new-guide", title: "New guide", reason: "Overloaded" },
    ];
    const adjusted = planWithFailedPages(
      plan(["guide", "new-guide", "faq"], ["overview"]),
      failed,
      new Set(["overview", "guide"]),
    );
    const expected = ["overview", "guide", "new-guide", "faq"]
      .filter((pageId) => !adjusted.leftOutPageIds.has(pageId));

    const pages = assembleIncrementalPages(
      expected,
      [[page("faq")]],
      [page("overview"), page("guide")],
      adjusted.plan,
    );

    expect(pages.map((assembled) => assembled.id)).toEqual(["overview", "guide", "faq"]);
  });

  test("assembles one regenerated page in structure order", () => {
    const overview = page("overview");
    const guide = page("guide");
    const result = assembleIncrementalPages(
      ["overview", "guide"],
      [[guide]],
      [overview],
      plan(["guide"], ["overview"]),
    );

    expect(result).toEqual([overview, guide]);
  });

  test("assembles a global regeneration without reused pages", () => {
    const pages = [page("overview"), page("guide")];

    expect(
      assembleIncrementalPages(
        ["overview", "guide"],
        [[pages[1]], [pages[0]]],
        [],
        plan(["overview", "guide"], []),
      ),
    ).toEqual(pages);
  });

  test("reuses the published body when a person changed the page", async () => {
    const generatedBody = "# Overview\n";
    const publishedBody = "# Overview, edited by hand\n";
    const state = pageState("overview", await sha256Hex(generatedBody));

    const reused = await materializeReusablePage({
      state,
      siteId: "site-1",
      baselineArtifactPrefix: "sites/site-1/versions/version-2",
      readArtifact: async (key) =>
        key === "sites/site-1/versions/version-2/source/index.mdx"
          ? publishedBody
          : generatedBody,
      hashContent: sha256Hex,
    });

    expect(reused.content).toBe(publishedBody);
    expect(reused.contentHash).toBe(await sha256Hex(publishedBody));
  });

  test("falls back to the verified state artifact when the baseline lacks the page", async () => {
    const body = "# Overview\n";
    const state = pageState("overview", await sha256Hex(body));

    const reused = await materializeReusablePage({
      state,
      siteId: "site-1",
      baselineArtifactPrefix: "sites/site-1/versions/version-2",
      readArtifact: async (key) => (key === state.artifactKey ? body : null),
      hashContent: sha256Hex,
    });

    expect(reused.content).toBe(body);
    expect(reused.contentHash).toBe(state.contentHash);
  });

  test("rejects corrupt fallback page content", async () => {
    const state = pageState("overview", hash);

    await expect(
      materializeReusablePage({
        state,
        siteId: "site-1",
        baselineArtifactPrefix: "sites/site-1/versions/version-2",
        readArtifact: async (key) =>
          key === state.artifactKey ? "# Tampered\n" : null,
        hashContent: sha256Hex,
      }),
    ).rejects.toThrow(
      "Reusable page artifact failed integrity validation: overview",
    );
  });

  test("rejects a fallback artifact from another site", async () => {
    const state = pageState("overview", hash);
    state.artifactKey = "sites/site-2/versions/version-1/source/index.mdx";

    await expect(
      materializeReusablePage({
        state,
        siteId: "site-1",
        baselineArtifactPrefix: "sites/site-1/versions/version-2",
        readArtifact: async () => null,
        hashContent: sha256Hex,
      }),
    ).rejects.toThrow("Reusable page state is invalid: overview");
  });

  test("detects a stale pull request before analysis", () => {
    const context = executionContext();

    expect(
      isAcceptedPullRequestRevision(context, {
        externalId: "pr-node-42",
        number: 42,
        draft: false,
        state: "open",
        baseRef: "main",
        baseRevision: "b".repeat(40),
        headRevision: "d".repeat(40),
        sourceUpdatedAt: "2026-07-23T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  test("keeps checkpoint replay assembly deterministic", () => {
    const inputs = {
      expectedPageIds: ["overview", "guide"],
      regeneratedBatches: [[page("guide")]],
      reusedPages: [page("overview")],
      plan: plan(["guide"], ["overview"]),
    };

    expect(
      assembleIncrementalPages(
        inputs.expectedPageIds,
        inputs.regeneratedBatches,
        inputs.reusedPages,
        inputs.plan,
      ),
    ).toEqual(
      assembleIncrementalPages(
        inputs.expectedPageIds,
        inputs.regeneratedBatches,
        inputs.reusedPages,
        inputs.plan,
      ),
    );
  });

  test("uses the model profile and fingerprint captured by job admission", () => {
    const context = executionContext();
    context.job.agentModel = "x-ai/grok-4.5";
    context.job.generationProfile = "full-prod";
    context.job.generatorFingerprint = "generator-v2";

    expect(resolvePreviewExecutionConfig(context)).toEqual({
      plannerModel: "x-ai/grok-4.5:nitro",
      writerModel: "moonshotai/kimi-k2.6:nitro",
      generationProfile: "full-prod",
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      generatorFingerprint: "generator-v2",
    });
    const config = resolvePreviewExecutionConfig(context);
    expect(modelForGenerationStage(config, "analysis")).toBe(
      "x-ai/grok-4.5:nitro",
    );
    expect(modelForGenerationStage(config, "structure")).toBe(
      "x-ai/grok-4.5:nitro",
    );
    expect(modelForGenerationStage(config, "write")).toBe(
      "moonshotai/kimi-k2.6:nitro",
    );
  });

  test("checks out a manual production job at its immutable default-branch revision", () => {
    const context = executionContext();
    context.job.trigger = "manual";
    context.job.publicationMode = "production";
    context.job.sourceProvider = null;
    context.job.sourceInstallationExternalId = null;
    context.job.changeExternalId = null;
    context.job.baselineRevision = "a".repeat(40);
    context.job.targetRevision = "c".repeat(40);
    context.changeProposal = null;

    expect(resolveGenerationCheckoutSpec(context)).toEqual({
      kind: "commit",
      baselineRevision: "a".repeat(40),
      targetRevision: "c".repeat(40),
    });
  });

  test("checks out a preview with no baseline against its pull request base", () => {
    // After the generation cache was cleared, a preview has no baseline.
    const context = executionContext();
    context.job.baselineRevision = null;
    context.job.baselineVersionId = null;
    const proposal = context.changeProposal;
    if (!proposal) throw new Error("The fixture is a preview context.");

    expect(resolveGenerationCheckoutSpec(context)).toMatchObject({
      kind: "pull_request_merge",
      baselineRevision: proposal.baseRevision,
      baseRevision: proposal.baseRevision,
    });
  });

  test("routes only fully captured production jobs through revision-aware generation", () => {
    const context = executionContext();
    context.job.trigger = "manual";
    context.job.publicationMode = "production";
    context.job.sourceProvider = null;
    context.job.sourceInstallationExternalId = null;
    context.job.changeExternalId = null;
    context.changeProposal = null;

    expect(isRevisionAwareProductionContext(context)).toBe(true);

    context.job.trigger = "merge";
    expect(isRevisionAwareProductionContext(context)).toBe(true);

    context.job.trigger = "doxabot";
    expect(isRevisionAwareProductionContext(context)).toBe(false);

    context.job.trigger = "manual";
    context.job.generatorFingerprint = null;
    expect(isRevisionAwareProductionContext(context)).toBe(false);
  });

  test("completes revision-aware production with permanent state metadata", () => {
    const context = executionContext();
    context.job.trigger = "manual";
    context.job.publicationMode = "production";
    context.job.sourceProvider = null;
    context.job.sourceInstallationExternalId = null;
    context.job.changeExternalId = null;
    context.job.baselineVersionId =
      "11111111-1111-4111-8111-111111111111";
    context.job.generatorFingerprint = "generator-v2";
    context.changeProposal = null;

    expect(
      createProductionCompletionInput(context, {
        versionId: "77777777-7777-4777-8777-777777777777",
        artifactPrefix:
          "sites/site-1/versions/77777777-7777-4777-8777-777777777777",
        manifestPath:
          "sites/site-1/versions/77777777-7777-4777-8777-777777777777/manifest.json",
        generationStatePrefix:
          "sites/site-1/generation-state/77777777-7777-4777-8777-777777777777",
        sourceRevision: "c".repeat(40),
        sourceTreeHash: "d".repeat(40),
        changedSourceCount: 2,
        regeneratedPageCount: 1,
        reusedPageCount: 3,
      }),
    ).toEqual({
      publicationMode: "publish",
      versionId: "77777777-7777-4777-8777-777777777777",
      artifactPrefix:
        "sites/site-1/versions/77777777-7777-4777-8777-777777777777",
      manifestPath:
        "sites/site-1/versions/77777777-7777-4777-8777-777777777777/manifest.json",
      generationStatePrefix:
        "sites/site-1/generation-state/77777777-7777-4777-8777-777777777777",
      sourceRevision: "c".repeat(40),
      sourceTreeHash: "d".repeat(40),
      baselineVersionId:
        "11111111-1111-4111-8111-111111111111",
      generatorFingerprint: "generator-v2",
      changedSourceCount: 2,
      regeneratedPageCount: 1,
      reusedPageCount: 3,
    });
  });
});

function plan(
  regeneratePageIds: string[],
  reusePageIds: string[],
): IncrementalGenerationPlan {
  return {
    analysisMode:
      regeneratePageIds.length > 0 ? "incremental" : "reuse",
    structureMode: "reuse",
    regeneratePageIds,
    reusePageIds,
    removedPageIds: [],
    modelCallsRequired: regeneratePageIds.length > 0,
    reasons: ["test plan"],
  };
}

function page(id: string): StagedRuntimePage {
  return {
    id,
    title: id === "overview" ? "Overview" : "Guide",
    route: id === "overview" ? "/" : `/${id}`,
    navigationPath: `default/${id}.md`,
    content: `# ${id}\n`,
    dependencies: emptyPageDependencyState(),
    contentHash: hash,
    pageInputHash: hash,
  };
}

function pageState(
  pageId: string,
  contentHash: string,
): GenerationPageState {
  return {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    pageId,
    title: "Overview",
    route: "/",
    navigationPath: "default/overview.md",
    artifactKey:
      "sites/site-1/versions/version-1/source/index.mdx",
    contentHash,
    pageInputHash: hash,
    dependencies: emptyPageDependencyState(),
  };
}

function executionContext(): GenerationExecutionContext {
  const baselineVersionId =
    "11111111-1111-4111-8111-111111111111";
  return {
    project: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Doxa",
      slug: "doxa",
      siteId: "33333333-3333-4333-8333-333333333333",
      siteSlug: "doxa",
    },
    repository: {
      id: "44444444-4444-4444-8444-444444444444",
      fullName: "doxa/private",
      defaultBranch: "main",
      installationId: "123",
      isPrivate: true,
    },
    sourceRepository: {
      externalId: "987",
      owner: "doxa",
      name: "private",
    },
    job: {
      id: "55555555-5555-4555-8555-555555555555",
      trigger: "doxabot",
      publicationMode: "preview",
      sourceProvider: "github",
      sourceInstallationExternalId: "123",
      changeExternalId: "pr-node-42",
      baselineRevision: "a".repeat(40),
      targetRevision: "c".repeat(40),
      sourceTreeHash: null,
      baselineVersionId,
      agentModel: "x-ai/grok-4.5",
      plannerModel: "x-ai/grok-4.5:nitro",
      writerModel: "moonshotai/kimi-k2.6:nitro",
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      generationProfile: "full-prod",
      generatorFingerprint: "doxabot-v1",
      externalReviewRunId: "9001",
    },
    changeProposal: {
      id: "66666666-6666-4666-8666-666666666666",
      externalId: "pr-node-42",
      number: 42,
      draft: false,
      state: "open",
      baseRef: "main",
      baseRevision: "b".repeat(40),
      headRevision: "c".repeat(40),
      repositoryExternalId: "987",
    },
    baselineVersion: {
      id: baselineVersionId,
      sourceRevision: "a".repeat(40),
      sourceTreeHash: "e".repeat(40),
      generatorFingerprint: "doxabot-v1",
      generationStatePrefix:
        `sites/33333333-3333-4333-8333-333333333333/generation-state/${baselineVersionId}`,
    },
    currentPreviewVersionId: null,
  };
}
