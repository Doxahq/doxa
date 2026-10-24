import { beforeEach, describe, expect, test, vi } from "vitest";
import { runRealGenerationJob } from "@doxahq/generation";
import { runContainerGeneration } from "../../src/services/container-generation";

vi.mock("@doxahq/generation", () => ({
  runRealGenerationJob: vi.fn(async () => ({ versionId: "version-1" })),
}));

vi.mock("../../src/services/internal-api", () => ({
  createLocalGenerationInternalApi: vi.fn(() => ({})),
}));

describe("container generation service", () => {
  beforeEach(() => {
    vi.mocked(runRealGenerationJob).mockClear();
  });

  test("passes independent local stage and overall budgets", async () => {
    await runContainerGeneration({
      GENERATION_MODE: "container-inline",
      DOCS_BUCKET: { put: vi.fn() },
      AGENT_CONTAINER_URL: "http://localhost:8789",
      OPENROUTER_API_KEY: "openrouter-secret",
      GENERATION_OVERALL_TIMEOUT_MS: "10800000",
      ANALYSIS_STAGE_TIMEOUT_MS: "2700000",
      STRUCTURE_STAGE_TIMEOUT_MS: "1800000",
      PAGE_BATCH_TIMEOUT_MS: "1800000",
      FINALIZATION_TIMEOUT_MS: "600000",
      GENERATION_IDLE_TIMEOUT_MS: "90000",
    } as never, { jobId: "job-1", projectId: "project-1" });

    expect(runRealGenerationJob).toHaveBeenCalledWith(
      { jobId: "job-1", projectId: "project-1" },
      expect.objectContaining({
        overallTimeoutMs: 10_800_000,
        analysisTimeoutMs: 2_700_000,
        structureTimeoutMs: 1_800_000,
        pageBatchTimeoutMs: 1_800_000,
        finalizationTimeoutMs: 600_000,
        idleTimeoutMs: 90_000,
      }),
    );
  });
});
