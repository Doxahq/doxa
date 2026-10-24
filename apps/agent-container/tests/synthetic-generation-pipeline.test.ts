import { describe, expect, test } from "vitest";
import { generationContextSchema } from "@doxahq/contracts";
import {
  runSyntheticGenerationPipeline,
} from "../synthetic/runner";

describe("synthetic generation pipeline", () => {
  test("runs the revision-aware production pipeline without external model calls", async () => {
    const result = await runSyntheticGenerationPipeline({
      seed: 1_729,
      console: false,
    });

    expect(result.status).toBe("succeeded");
    expect(result.versionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.pageCount).toBe(3);
    expect(result.artifactKeys).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/manifest\.json$/),
        expect.stringMatching(/\/settings\/site\.json$/),
        expect.stringMatching(/\/source\/overview\/index\.mdx$/),
      ]),
    );
    expect(result.permanentStateKeys.length).toBeGreaterThan(0);
    expect(result.artifactKeys.some((key) => key.endsWith("/settings/features.json"))).toBe(false);
    expect(result.transientCheckpointKeys).toEqual([]);
    expect(result.modelCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "plan",
          model: "synthetic/planner",
        }),
        expect.objectContaining({
          stage: "write",
          model: "synthetic/writer",
        }),
      ]),
    );
    expect(
      result.logs.filter(
        (entry) =>
          entry.event === "stage.requested" &&
          entry.data?.stage === "plan",
      ),
    ).toHaveLength(1);
    expect(
      result.logs.filter(
        (entry) =>
          entry.event === "stage.requested" &&
          (entry.data?.stage === "analysis" ||
            entry.data?.stage === "structure"),
      ),
    ).toHaveLength(0);
    expect(JSON.parse(result.planningCheckpoints.analysis)).toMatchObject({
      stage: "analysis",
      analysisState: expect.any(Object),
    });
    expect(JSON.parse(result.planningCheckpoints.structure)).toMatchObject({
      stage: "structure",
      structureState: expect.any(Object),
      runtimeFeatures: { apiPlayground: true },
    });
    expect(result.logs.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        "run.started",
        "workflow.step.started",
        "stage.requested",
        "agent.model.requested",
        "agent.writer_diagnostic",
        "agent.progress",
        "stage.completed",
        "artifact.written",
        "workflow.completed",
        "run.completed",
      ]),
    );
    expect(
      result.logs.filter(
        (entry) =>
          entry.event === "stage.requested" &&
          entry.data?.stage === "write",
      ),
    ).toHaveLength(2);
    expect(
      result.logs.some(
        (entry) => entry.data?.type === "stage_timing_summary",
      ),
    ).toBe(false);
    const writeSummaries = result.performanceRecords
      .map((record) => record.summary)
      .filter((summary) => summary.stage === "write");
    expect(writeSummaries).toHaveLength(2);
    for (const summary of writeSummaries) {
      expect(summary).toMatchObject({
        busyMs: expect.any(Number),
        peakConcurrentModelSpans: expect.any(Number),
        evidenceFirstPages: expect.any(Number),
        agenticFallbackPages: expect.any(Number),
      });
    }
    expect(
      writeSummaries.reduce(
        (total, summary) =>
          total + summary.evidenceFirstPages + summary.agenticFallbackPages,
        0,
      ),
    ).toBe(result.pageCount);
  }, 30_000);

  test("preserves published settings through production generation", async () => {
    const { siteConfig } = generationContextSchema.parse({
      project: { id: "p", siteId: "s", siteSlug: "s", name: "Project", slug: "project" },
      repository: { id: "r", fullName: "owner/repo", defaultBranch: "main", installationId: "i" },
      siteConfig: { name: "Custom docs", theme: { preset: "brutalist" }, features: { apiPlayground: false }, branding: { poweredBy: false } },
    });
    const result = await runSyntheticGenerationPipeline({ seed: 1_729, console: false, siteConfig, entitlements: { removePoweredBy: true, maxBranchesPerSite: 10 } });
    expect(JSON.parse(result.siteConfigJson ?? "null")).toEqual(siteConfig);
  }, 30_000);

  test("keeps the legacy two-stage workflow selectable without changing checkpoints", async () => {
    const combined = await runSyntheticGenerationPipeline({
      seed: 1_729,
      console: false,
    });
    const legacy = await runSyntheticGenerationPipeline({
      seed: 1_729,
      console: false,
      planStageEnabled: false,
    });

    expect(
      legacy.logs.filter(
        (entry) =>
          entry.event === "stage.requested" &&
          entry.data?.stage === "plan",
      ),
    ).toHaveLength(0);
    expect(
      legacy.logs.filter(
        (entry) =>
          entry.event === "stage.requested" &&
          entry.data?.stage === "analysis",
      ),
    ).toHaveLength(1);
    expect(
      legacy.logs.filter(
        (entry) =>
          entry.event === "stage.requested" &&
          entry.data?.stage === "structure",
      ),
    ).toHaveLength(1);
    expect(normalizeRevisions(combined.planningCheckpoints)).toEqual(
      normalizeRevisions(legacy.planningCheckpoints),
    );
    expect(combined.pageCount).toBe(legacy.pageCount);
  }, 30_000);
});

function normalizeRevisions(
  checkpoints: {
    analysis: string;
    structure: string;
  },
) {
  return Object.fromEntries(
    Object.entries(checkpoints).map(([name, checkpoint]) => [
      name,
      JSON.parse(JSON.stringify(
        JSON.parse(checkpoint),
        (key, value) =>
          key === "targetRevision" || key === "sourceRevision"
            ? "<revision>"
            : value,
      )),
    ]),
  );
}
