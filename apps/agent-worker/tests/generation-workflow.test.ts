import { describe, expect, test } from "vitest";
import { emptyPageDependencyState } from "@doxahq/contracts";
import { assembleCheckpointedPages } from "../src/generation-workflow";
import * as workflowRuntime from "../src/generation-workflow-runtime";

describe("durable generation workflow", () => {
  const hash = "a".repeat(64);
  const pages = [
    {
      id: "overview",
      title: "Overview",
      route: "/",
      navigationPath: "default/overview.md",
      content: "# Overview\n",
      dependencies: emptyPageDependencyState(),
      contentHash: hash,
      pageInputHash: hash,
    },
    {
      id: "install",
      title: "Install",
      route: "/install",
      navigationPath: "default/install.md",
      content: "# Install\n",
      dependencies: emptyPageDependencyState(),
      contentHash: hash,
      pageInputHash: hash,
    },
  ];

  test("assembles checkpoint batches in structure order", () => {
    expect(assembleCheckpointedPages(["overview", "install"], [[pages[1]], [pages[0]]])).toEqual(pages);
  });

  test("rejects duplicate or missing page checkpoints", () => {
    expect(() => assembleCheckpointedPages(["overview", "install"], [[pages[0]], [pages[0]]])).toThrow(
      "Duplicate generated page checkpoint: overview",
    );
  });
});

describe("workflow retry boundaries", () => {
  test("converts cancellation to a platform error inside the individual step", async () => {
    expect(workflowRuntime.adaptGenerationWorkflowStep).toBeTypeOf("function");

    const platformError = new Error("platform non-retryable");
    let errorObservedInsideStep: unknown;
    const platformStep: workflowRuntime.GenerationWorkflowStep = {
      async do(_name, _config, callback) {
        try {
          return await callback();
        } catch (error) {
          errorObservedInsideStep = error;
          throw error;
        }
      },
    };
    const adaptedStep = workflowRuntime.adaptGenerationWorkflowStep(
      platformStep,
      () => platformError,
    );

    await expect(
      adaptedStep.do("cancelled generation", {}, async () => {
        throw new workflowRuntime.GenerationNonRetryableError(
          "Generation job is no longer active.",
        );
      }),
    ).rejects.toBe(platformError);
    expect(errorObservedInsideStep).toBe(platformError);
  });

  test("rejects an incompatible database before generation stages run", () => {
    expect(() => workflowRuntime.assertGenerationDatabaseCompatible({
      ready: false,
      missingColumns: ["writer_attempt", "max_attempts"],
    })).toThrow(
      "Generation database schema is incompatible; missing columns: max_attempts, writer_attempt.",
    );
  });
});
