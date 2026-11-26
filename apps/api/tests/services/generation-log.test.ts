import type { JobEventDto, JobEventSource } from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import { toGenerationLog, toGenerationLogEvent } from "../../src/services/generation-log";

let sequence = 0;

function event(
  type: string,
  message: string,
  data: Record<string, unknown> | null = null,
  source: JobEventSource = "container",
): JobEventDto {
  sequence += 1;
  return {
    id: `event-${sequence}`,
    jobId: "job-1",
    sequence,
    source,
    type,
    message,
    data,
    createdAt: "2026-10-23T18:41:00.000Z",
  };
}

function lines(events: JobEventDto[]): string[] {
  return toGenerationLog(events).map((logEvent) => `${logEvent.phase} ${logEvent.level} ${logEvent.message}`);
}

const REVISION = "1a7e698ca2e558aee69d1fc52bc645be4919c6ac";
const MODELS = {
  model: "x-ai/grok-4.5:nitro",
  writerModel: "openai/gpt-5.6-luna",
  plannerModel: "x-ai/grok-4.5:nitro",
};

describe("generation log", () => {
  test("rewrites a full production run without models, budgets or internal stages", () => {
    const run = [
      event("queued", "Generation job queued.", null, "api"),
      event("running", "Generation started.", null, "api"),
      event("production_workflow_started", "Revision-aware production documentation workflow started.", {
        ...MODELS,
        targetRevision: REVISION,
        baselineVersionId: null,
        generationProfile: "fast-mvp",
        repositoryFullName: "ipenywis/flagforge",
      }, "worker"),
      event("container_stage_booted", "Agent container started plan stage.", { ...MODELS, stage: "plan" }),
      event("snapshot_started", "Preparing exact source revision for ipenywis/flagforge.", {
        stage: "plan",
        checkoutKind: "commit",
        targetRevision: REVISION,
      }),
      event("snapshot_complete", "Exact source revision for ipenywis/flagforge is ready.", {
        stage: "plan",
        sourceTreeHash: "4a88cdded2607a2f34406c4a1106df2115d48775",
      }),
      event("analysis_started", "Analyzing repository.", { stage: "plan" }),
      event("analysis_progress", "Starting project analysis...", { stage: "analyzing", progress: 0 }),
      event("analysis_progress", "Exploring codebase...", { stage: "analyzing", progress: 10 }),
      event("analysis_progress", "Exploring codebase (Glob)...", { stage: "analyzing", progress: 18 }),
      event("analysis_progress", "Exploring codebase (Read)...", { stage: "analyzing", progress: 50 }),
      event("analysis_progress", "Exploring codebase (Grep)...", { stage: "analyzing", progress: 60 }),
      event("analysis_progress", "Exploring codebase (WebFetch)...", { stage: "analyzing", progress: 60 }),
      event("analysis_progress", "Generating project analysis...", { stage: "analyzing", progress: 70 }),
      event("analysis_progress", "Parsing analysis results...", { stage: "analyzing", progress: 85 }),
      event("analysis_progress", "Analysis complete", { stage: "analyzing", progress: 100 }),
      event("analysis_complete", "Revision-aware repository analysis checkpoint created.", {
        stage: "plan",
        reason: "No compatible published generation state is available.",
        analysisMode: "full",
        modelCallsRequired: false,
      }),
      event("structure_started", "Creating documentation structure.", { stage: "plan" }),
      event("stage_progress", "Generating documentation structure...", { stage: "proposing", progress: 0 }),
      event("stage_progress", "Parsing structure...", { stage: "proposing", progress: 85 }),
      event("stage_progress", "Documentation structure ready", { stage: "proposing", progress: 100 }),
      event("structure_review_started", "Reviewing documentation structure for public readers.", {
        stage: "plan",
        proposedPageCount: 50,
        editorialPageBudget: 24,
      }),
      event(
        "stage_progress",
        "Retrying structure review with validation feedback (attempt 2/3)...",
        { stage: "proposing", progress: 90 },
      ),
      event("structure_budget_applied", "Documentation structure budget evaluated.", {
        stage: "plan",
        editorialBudget: 24,
        generationProfile: "fast-mvp",
      }),
      event("structure_created", "Documentation structure checkpoint created.", {
        stage: "plan",
        reason: "No compatible published generation state is available.",
        pageCount: 47,
        sectionCount: 3,
        reusePageCount: 0,
        regeneratePageCount: 47,
      }),
      event("container_stage_booted", "Agent container started write stage.", { ...MODELS, stage: "write" }),
      event("snapshot_started", "Preparing exact source revision for ipenywis/flagforge.", {
        stage: "write",
        targetRevision: REVISION,
      }),
      event("snapshot_complete", "Exact source revision for ipenywis/flagforge is ready.", { stage: "write" }),
      event("writing_started", "Writing 6 documentation page(s).", {
        stage: "write",
        pageCount: 6,
        pageConcurrency: 6,
      }),
      event("stage_progress", "Preparing to write documentation...", { stage: "gathering", progress: 0 }),
      event("page_write_completed", "Writing: Projects and Environments (1/6)", {
        stage: "writing",
        progress: 17,
        currentItem: "Projects and Environments",
      }),
      event("page_write_completed", "Writing: Quickstart (6/6)", {
        stage: "writing",
        currentItem: "Quickstart",
      }),
      event(
        "page_write_completed",
        "Quality repair 1/2 for Quickstart — global repair 1/3; rule: quickstart-undefined-shell-variable",
        { stage: "writing", progress: 95, currentItem: "Quickstart" },
      ),
      event("stage_progress", "Generated 6 documentation pages", { stage: "complete", progress: 100 }),
      event("pages_written", "6 documentation page(s) checkpointed.", { stage: "write", pageCount: 6 }),
      event(
        "artifact_link_warning",
        "Generated page /self-hosting links to a route absent from final navigation: /rest-api/index.",
        { page: "/self-hosting", route: "/rest-api/index" },
        "worker",
      ),
      event("published", "Docs published.", {
        outcome: "succeeded",
        terminal: true,
        versionId: "9ac7abfb-4918-4b58-8fc5-3539f39f4aec",
        reusedPageCount: 0,
        changedSourceCount: 0,
        regeneratedPageCount: 47,
      }, "worker"),
    ];

    expect(lines(run)).toEqual([
      "run info Generation queued.",
      "run info Generation started.",
      "setup info Generating the docs for the first time.",
      "setup info Getting the source code of ipenywis/flagforge at commit 1a7e698.",
      "setup info Source code ready.",
      "analyze info Analyzing the repository.",
      "analyze info Exploring the codebase.",
      "analyze info Finding files.",
      "analyze info Reading files.",
      "analyze info Searching the code.",
      "analyze info Exploring the codebase.",
      "analyze info Writing the project analysis.",
      "analyze info Checking the analysis.",
      "analyze info Analysis done. There are no published docs to reuse, so the full repository was analyzed.",
      "plan info Planning the documentation structure.",
      "plan info Reviewing the plan of 50 pages for readers.",
      "plan warning The review found problems. Reviewing again (attempt 2 of 3).",
      "plan info Structure ready: 47 pages in 3 sections.",
      "write info Writing 6 pages.",
      "write info Wrote \"Projects and Environments\".",
      "write info Wrote \"Quickstart\".",
      "write info Improving \"Quickstart\": a shell variable in an example has no value (fix 1 of 2).",
      "write info Finished: 6 pages written.",
      "publish warning The page /self-hosting links to /rest-api/index, which is not in the navigation.",
      "publish info Docs published: 47 pages from this run, 0 kept from the published docs.",
    ]);
  });

  test("rewrites a Doxabot preview run that reuses the published docs", () => {
    const run = [
      event("doxabot_queued", "Doxabot preview generation queued.", {
        provider: "github",
        targetRevision: "d76b91e49ba016810c063d342f726bf752fa2f77",
        changeExternalId: "4954223523",
      }, "system"),
      event(
        "review_run_create_failed",
        "Doxabot could not create the external review run.",
        { error: "internal error; reference = 8agn9h92snh8ihs0bg6dkdf0" },
        "system",
      ),
      event("running", "Generation started.", null, "api"),
      event("preview_workflow_started", "Incremental documentation preview workflow started.", {
        writerModel: "claude-haiku-5-5",
        plannerModel: "claude-sonnet-5-5",
        modelProvider: "anthropic",
        baselineVersionId: "02974c40-6c66-4658-a840-f81c1228e39d",
      }, "worker"),
      event("analysis_progress", "Reusing published project analysis.", { stage: "analyzing", progress: 100 }),
      event("analysis_complete", "Revision-aware repository analysis checkpoint created.", {
        stage: "plan",
        reason: "22 page(s) have new page inputs; source changes do not affect the others.",
        referenceSource: { status: "openapi", readerVersion: "ae8b4dfa8eb550d6" },
      }),
      event(
        "api_reference_source",
        "Read 2 OpenAPI specs (apps/api/openapi/openapi.json, apps/api/openapi/openapi.yaml): 22 endpoints.",
        { status: "openapi", endpoints: 22 },
      ),
      event("structure_reused", "Reusing the compatible published documentation structure.", { pageCount: 77 }),
      event("structure_created", "Documentation structure checkpoint created.", {
        pageCount: 77,
        sectionCount: 3,
        reusePageCount: 55,
        regeneratePageCount: 22,
      }),
      event("pages_written", "22 documentation page(s) checkpointed.", {
        stage: "write",
        pageCount: 22,
        failedPageCount: 0,
      }),
      event("preview_published", "Documentation preview published.", {
        versionId: "5c54b8fa-7acc-484c-8fed-042b7f143a0e",
        reusedPageCount: 55,
        regeneratedPageCount: 22,
      }, "worker"),
    ];

    expect(lines(run)).toEqual([
      "run info Doxabot queued a preview for commit d76b91e.",
      "run warning Doxabot could not create the check on the pull request. The preview continues.",
      "run info Generation started.",
      "setup info Updating the preview from the published docs.",
      "analyze info Reused the published project analysis.",
      "analyze info Analysis done. 22 pages have new inputs. The source changes do not affect the other pages.",
      "analyze info Read 2 OpenAPI specs (apps/api/openapi/openapi.json, apps/api/openapi/openapi.yaml): 22 endpoints.",
      "plan info Reused the published structure: 77 pages.",
      "plan info Structure ready: 77 pages in 3 sections. 22 pages to write. 55 pages stay as they are.",
      "write info Finished: 22 pages written.",
      "publish info Preview published: 22 pages from this run, 55 kept from the published docs.",
    ]);
  });

  test("keeps retries and cache reuse without the model or the raw error", () => {
    expect(lines([
      event(
        "page_write_completed",
        "Retrying failed page: Overview (retry 2, fallback model claude-sonnet-5-5)",
        { stage: "writing", currentItem: "Overview" },
      ),
      event("page_write_completed", "Recovered failed page: Overview", {
        stage: "writing",
        currentItem: "Overview",
      }),
      event("analysis_progress", "Using cached analysis (no changes since 1a7e698)", { stage: "analyzing" }),
      event("stage_progress", "All 12 pages up to date (cached)", { stage: "complete" }),
      event("plan_cache_hit", "Reused the plan of an earlier run of the same source revision and settings.", {
        pageCount: 47,
      }, "worker"),
      event("generation_stage_attempt_retrying", "Write stage attempt failed and will retry: 529 overloaded from provider", {
        stage: "write",
        retryable: true,
        code: "provider_overloaded",
      }, "worker"),
      event("snapshot_retrying", "GitHub snapshot attempt 1 of 3 failed; retrying attempt 2 in 500ms.", {
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        reason: "ECONNRESET",
      }),
    ])).toEqual([
      "write warning Writing \"Overview\" again (retry 2).",
      "write info Recovered \"Overview\".",
      "analyze info Reused the analysis of an earlier run. No code changed since commit 1a7e698.",
      "write info All 12 pages are up to date. Reused them.",
      "plan info Reused the plan of an earlier run of the same code and settings.",
      "write warning A writing step failed. Trying it again.",
      "setup warning Getting the source code failed. Trying again (attempt 2 of 3).",
    ]);
  });

  // 2026-11-16: a run of the same code took 2s and charged only the base fee.
  // The log said "87 pages written" and did not say why it was so quick.
  test("says that pages came from the page cache, and why", () => {
    expect(lines([
      event("page_cache_reused", "Reused 87 page(s) from earlier runs with the same inputs.", {
        cachedPageCount: 87,
        writtenPageCount: 0,
      }, "worker"),
      event("page_cache_reused", "Reused 60 page(s) from earlier runs with the same inputs.", {
        cachedPageCount: 60,
        writtenPageCount: 27,
      }, "worker"),
      event("page_cache_reused", "Nothing reused.", { cachedPageCount: 0, writtenPageCount: 12 }, "worker"),
      event("staged_for_review", "The generated docs are ready for review.", {
        regeneratedPageCount: 87,
        reusedPageCount: 0,
      }),
    ])).toEqual([
      "write info Reused 87 pages from earlier runs. Their source files, plan, links and Doxabot instructions did not change, so Doxa did not write them again.",
      "write info Reused 60 pages from earlier runs. Their source files, plan, links and Doxabot instructions did not change, so Doxa did not write them again. Doxa wrote the other 27 pages.",
      "review info The docs are ready for review: 87 pages from this run, 0 kept from the published docs.",
    ]);
  });

  test("hides event types and progress messages that it does not know", () => {
    expect(toGenerationLogEvent(event("some_future_internal_event", "Internal detail."))).toBeNull();
    expect(toGenerationLogEvent(event("analysis_progress", "Calling model foo/bar...", {
      stage: "analyzing",
    }))).toBeNull();
    expect(toGenerationLogEvent(event("database_schema_incompatible", "Missing column x.", null, "worker"))).toBeNull();
  });

  test("names an unknown quality rule as a failed check", () => {
    expect(lines([
      event(
        "page_write_completed",
        "Quality repair 2/2 for Setup — global repair 3/3; rule: some-new-rule",
        { stage: "writing", currentItem: "Setup" },
      ),
    ])).toEqual(["write info Improving \"Setup\": a quality check failed (fix 2 of 2)."]);
  });

  test("keeps the id, sequence and type of a kept event and keeps only its elapsed time", () => {
    const stored = event("pages_written", "6 documentation page(s) checkpointed.", {
      pageCount: 6,
      elapsedMs: 1000,
      containerSequence: 9,
    });

    expect(toGenerationLogEvent(stored)).toEqual({
      id: stored.id,
      jobId: stored.jobId,
      sequence: stored.sequence,
      source: stored.source,
      type: "pages_written",
      message: "Finished: 6 pages written.",
      data: { elapsedMs: 1000 },
      createdAt: stored.createdAt,
      phase: "write",
      level: "info",
    });
  });
});

describe("generation log lines for the Doxabot instructions", () => {
  test("shows removed planned pages, page notices and an unloadable context", () => {
    expect(lines([
      event("generation_context_unavailable", "Doxa could not read .doxa/instructions.md.", null, "worker"),
      event("structure_pages_removed_by_instructions", "Left out 1 planned page that the project instructions rule out: \"FAQ\".", {
        removedPageCount: 1,
      }),
      event("generation_page_notice", "Guide may not follow the Doxabot instructions: Say \"repository\".", null, "worker"),
    ])).toEqual([
      "setup error Doxa could not read .doxa/instructions.md.",
      "plan warning Left out 1 planned page that the project instructions rule out: \"FAQ\".",
      "write warning Guide may not follow the Doxabot instructions: Say \"repository\".",
    ]);
  });
});

describe("generation log lines for AI credits (billing spec 10.5, 10.6)", () => {
  const credits = { usedCredits: 1240, holdCredits: 1500, capCredits: 3000, fromPaygCredits: 40 };

  test("keeps the live meter numbers of a credits event and nothing else", () => {
    const stored = event("credits", "Credits.", { ...credits, shadow: false, accountId: "acct-1", modelCostUsd: "0.41" }, "api");

    expect(toGenerationLogEvent(stored)).toEqual({
      id: stored.id,
      jobId: stored.jobId,
      sequence: stored.sequence,
      source: "api",
      type: "credits",
      message: "1,240 credits used so far.",
      // An event from before the job total reads its try as the total.
      data: { ...credits, jobUsedCredits: credits.usedCredits, shadow: false },
      createdAt: stored.createdAt,
      phase: "run",
      level: "info",
    });
  });

  test("a continued run's line shows the job total, not the try", () => {
    const stored = event("credits", "Credits.", { ...credits, usedCredits: 60, jobUsedCredits: 1_300, shadow: false }, "api");
    expect(toGenerationLogEvent(stored)).toMatchObject({
      message: "1,300 credits used so far.",
      data: { usedCredits: 60, jobUsedCredits: 1_300 },
    });
  });

  test("hides a shadow credits event and a malformed one", () => {
    expect(toGenerationLog([
      event("credits", "Credits.", { ...credits, shadow: true }, "api"),
      event("credits", "Credits.", { usedCredits: "many" }, "api"),
      event("credits", "Credits.", null, "api"),
    ])).toEqual([]);
  });

  test("keeps the reason and the finished pages of a credits_stopped event", () => {
    const stored = event("credits_stopped", "Stopped: the AI credits ran out.", {
      reason: "credit_cap",
      finishedPageCount: 12,
      outcome: "stopped_credits",
      terminal: true,
    }, "api");

    expect(toGenerationLogEvent(stored)).toMatchObject({
      type: "credits_stopped",
      message: "The run stopped at its credit cap. 12 pages are finished.",
      data: { reason: "credit_cap", finishedPageCount: 12 },
      phase: "run",
      level: "warning",
    });
    expect(toGenerationLogEvent(event("credits_stopped", "Stopped.", { reason: "credits_exhausted" }, "api"))).toMatchObject({
      message: "The run stopped because the AI credits ran out.",
      data: { reason: "credits_exhausted" },
    });
  });

  test("shows an unknown credit stop reason without its data", () => {
    expect(toGenerationLogEvent(event("credits_stopped", "Stopped.", { reason: "secret_internal" }, "api"))).toMatchObject({
      message: "The run stopped for AI credits.",
      data: null,
      level: "warning",
    });
  });
});

describe("retries from the pull request check", () => {
  test("names the person who asked, and why nothing started", () => {
    expect(
      lines([
        event("doxabot_retry_requested", "@maintainer asked to run this preview again.", { login: "maintainer", trigger: "rerun" }, "api"),
        event("doxabot_retry_refused", "Doxabot did not run this preview again.", { login: "maintainer", reason: "not_permitted" }, "api"),
      ]),
    ).toEqual([
      "run info @maintainer asked on the pull request to run this preview again.",
      "run warning Doxabot did not run this preview again: only people who can push to the repository can start it.",
    ]);
  });

  test("an unknown refusal code shows the plain refusal, never the code", () => {
    expect(
      lines([event("doxabot_retry_refused", "Doxabot did not run this preview again.", { reason: "dispatch_failed" }, "api")]),
    ).toEqual(["run warning Doxabot did not run this preview again."]);
  });
});
