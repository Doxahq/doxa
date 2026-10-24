import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerGenerationStageRequest } from "@doxahq/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

const ensureRepositorySnapshot = vi.hoisted(() => vi.fn());

vi.mock("../src/repository-snapshot", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/repository-snapshot")>();
  return {
    ...actual,
    ensureRepositorySnapshot,
  };
});

import { runGenerationStage } from "../src/staged-generation";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  ensureRepositorySnapshot.mockReset();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("snapshot retry observability", () => {
  test("streams a visible retry event with attempt details and sanitized reason", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "doxa-snapshot-events-"));
    temporaryDirectories.push(baseDir);
    const targetRevision = "b".repeat(40);
    const events: Array<{
      type: string;
      message: string;
      data?: Record<string, unknown>;
    }> = [];
    ensureRepositorySnapshot.mockImplementation(
      async (_input, options: {
        onRetry?: (retry: {
          attempt: number;
          nextAttempt: number;
          maxAttempts: number;
          delayMs: number;
          reason: string;
        }) => Promise<void> | void;
      }) => {
        await options.onRetry?.({
          attempt: 1,
          nextAttempt: 2,
          maxAttempts: 3,
          delayMs: 1_250,
          reason:
            "Failed to connect to https://x-access-token:[redacted]@github.com.",
        });
        return {
          outcome: "merge_conflict",
          targetRevision,
          message: "Synthetic merge conflict.",
        };
      },
    );

    const request: ContainerGenerationStageRequest = {
      stage: "analysis",
      jobId: "11111111-1111-4111-8111-111111111111",
      repositoryFullName: "doxa/private-repository",
      installationAccessToken: "installation-token",
      modelProvider: "openrouter",
      modelApiKey: "openrouter-key",
      model: "x-ai/grok-4.5:nitro",
      generationProfile: "fast-mvp",
      siteId: "site-1",
      versionId: "version-1",
      projectSlug: "private-repository",
      projectName: "Private Repository",
      checkoutSpec: {
        kind: "commit",
        baselineRevision: "a".repeat(40),
        targetRevision,
      },
    };

    await runGenerationStage(
      request,
      async (type, message, data) => {
        events.push({ type, message, data });
      },
      new AbortController(),
      {},
      { workspaceBaseDir: baseDir },
    );

    expect(events).toContainEqual({
      type: "snapshot_retrying",
      message:
        "GitHub snapshot attempt 1 of 3 failed; retrying attempt 2 in 1250ms.",
      data: {
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 1_250,
        reason:
          "Failed to connect to https://x-access-token:[redacted]@github.com.",
      },
    });
  });
});
