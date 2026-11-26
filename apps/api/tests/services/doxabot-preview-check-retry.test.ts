import type { GenerationJobDto, NormalizedReviewRunRetryEvent } from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";

// The re-run service reaches the Worker entrypoint module through its imports.
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));
import type { DoxabotAutomationContext } from "../../src/repositories/doxabot-settings";
import type { ReviewRunJobContext } from "../../src/repositories/jobs";
import type { GenerationRerunOutcome } from "../../src/services/generation-rerun";
import { PreviewCheckRetryService } from "../../src/services/doxabot/preview-check-retry";

const jobId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const newJobId = "33333333-3333-4333-8333-333333333333";

const event: NormalizedReviewRunRetryEvent = {
  kind: "review_run_retry",
  deliveryId: "delivery-1",
  repository: {
    provider: "github",
    externalId: "123456",
    installationExternalId: "789",
    visibility: "private",
    defaultBranch: "main",
  },
  externalRunId: "9001",
  jobId,
  trigger: "retry_action",
  requestedBy: { externalId: "7", login: "maintainer" },
};

const automation: DoxabotAutomationContext = {
  projectId,
  ownerUserId: "owner-1",
  repositoryExternalId: "123456",
  installationExternalId: "789",
  repositoryOwner: "doxahq",
  repositoryName: "doxa",
  repositoryVisibility: "private",
  productionBranch: "main",
  storedEnabled: true,
  mergeTrigger: "batched",
  allowedBotLogins: [],
  connectionIssue: null,
  hasPublishedVersion: true,
  publishedBaseline: null,
};

function job(id: string): GenerationJobDto {
  return {
    id,
    projectId,
    status: "queued",
    docsVersionId: null,
    errorMessage: null,
    createdAt: "2026-11-25T18:00:00.000Z",
    updatedAt: "2026-11-25T18:00:00.000Z",
  };
}

const suspended: DoxabotAutomationContext = { ...automation, connectionIssue: "installation_suspended" };

const check: ReviewRunJobContext = {
  jobId,
  projectId,
  status: "failed",
  errorMessage: "Clone failed.",
  provider: "github",
  targetRevision: "b".repeat(40),
  externalReviewRunId: "9001",
  cancelledPresentation: null,
  repository: { externalId: "123456", owner: "doxahq", name: "doxa", installationExternalId: "789" },
};

function setup(overrides: {
  automation?: DoxabotAutomationContext | null;
  check?: ReviewRunJobContext | null;
  canWrite?: () => Promise<boolean>;
  rerun?: GenerationRerunOutcome;
} = {}) {
  const addEvent = vi.fn(async () => undefined);
  const canWrite = vi.fn(overrides.canWrite ?? (async () => true));
  const rerun = vi.fn(async (): Promise<GenerationRerunOutcome> =>
    overrides.rerun ?? { outcome: "started", job: job(newJobId) },
  );
  const service = new PreviewCheckRetryService({
    settings: { getAutomationContext: vi.fn(async () => (overrides.automation === undefined ? automation : overrides.automation)) },
    checks: { getReviewRunContext: vi.fn(async () => (overrides.check === undefined ? check : overrides.check)) },
    events: { addEvent },
    permissions: { canWrite },
    reruns: { rerun },
  });
  return { service, addEvent, canWrite, rerun };
}

describe("running a preview again from its pull request check", () => {
  test("a person who can push starts the re-run, paid by the project owner", async () => {
    const { service, rerun, canWrite, addEvent } = setup();

    await expect(service.retry(event)).resolves.toEqual({ outcome: "started", jobId: newJobId });

    expect(canWrite).toHaveBeenCalledWith({
      repositoryOwner: "doxahq",
      repositoryName: "doxa",
      repositoryExternalId: "123456",
      installationExternalId: "789",
      login: "maintainer",
    });
    expect(rerun).toHaveBeenCalledWith({ userId: "owner-1", projectId, jobId, force: true });
    expect(addEvent).toHaveBeenCalledWith(
      jobId,
      "doxabot_retry_requested",
      "@maintainer asked to run this preview again.",
      { login: "maintainer", trigger: "retry_action" },
    );
  });

  test("a person without write access starts nothing, and the run records why", async () => {
    const { service, rerun, addEvent } = setup({ canWrite: async () => false });

    await expect(service.retry(event)).resolves.toEqual({ outcome: "refused", reason: "not_permitted" });

    expect(rerun).not.toHaveBeenCalled();
    expect(addEvent).toHaveBeenLastCalledWith(jobId, "doxabot_retry_refused", "Doxabot did not run this preview again.", {
      login: "maintainer",
      reason: "not_permitted",
    });
  });

  test("an unanswered permission check starts nothing", async () => {
    const { service, rerun } = setup({
      canWrite: async () => {
        throw new Error("GitHub collaborator permission lookup failed (502).");
      },
    });

    await expect(service.retry(event)).resolves.toEqual({ outcome: "refused", reason: "permission_unknown" });
    expect(rerun).not.toHaveBeenCalled();
  });

  test.each([
    ["no project has the repository", { automation: null }, "project_not_found"],
    ["GitHub took the repository away", { automation: suspended }, "repository_unavailable"],
    ["the job has no check", { check: null }, "check_not_found"],
    ["the check is another project's", { check: { ...check, projectId: "44444444-4444-4444-8444-444444444444" } }, "check_not_found"],
    ["the job stores another check run", { check: { ...check, externalReviewRunId: "8001" } }, "check_not_found"],
    ["the check is on another repository", { check: { ...check, repository: { ...check.repository, externalId: "999" } } }, "check_not_found"],
  ] as const)("refuses when %s, before any GitHub call", async (_name, overrides, reason) => {
    const { service, canWrite, rerun, addEvent } = setup(overrides);

    await expect(service.retry(event)).resolves.toEqual({ outcome: "refused", reason });

    expect(canWrite).not.toHaveBeenCalled();
    expect(rerun).not.toHaveBeenCalled();
    // A check that is not this project's gets no events on the named job.
    expect(addEvent).not.toHaveBeenCalled();
  });

  test.each([
    [{ outcome: "blocked", reason: "superseded" }, "superseded"],
    [{ outcome: "already_active", job: job(newJobId) }, "already_active"],
    [{ outcome: "paused" }, "paused"],
  ] satisfies Array<[GenerationRerunOutcome, string]>)("records a re-run that did not start (%o)", async (outcome, reason) => {
    const { service, addEvent } = setup({ rerun: outcome });

    await expect(service.retry(event)).resolves.toEqual({ outcome: "refused", reason });
    expect(addEvent).toHaveBeenLastCalledWith(jobId, "doxabot_retry_refused", expect.any(String), {
      login: "maintainer",
      reason,
    });
  });

  test("a failed event write does not change the outcome", async () => {
    const { service, addEvent } = setup();
    addEvent.mockRejectedValue(new Error("database unavailable"));

    await expect(service.retry(event)).resolves.toEqual({ outcome: "started", jobId: newJobId });
  });
});
