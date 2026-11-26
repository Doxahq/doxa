import type { GenerationLogPhase, JobEventDto } from "@doxahq/contracts";
import {
  GENERATION_CREDITS_EVENT_TYPE,
  GENERATION_CREDITS_STOPPED_EVENT_TYPE,
  generationCreditsEventDataSchema,
  generationCreditsStoppedEventDataSchema,
} from "@doxahq/contracts/billing";
import {
  attemptText,
  hidden,
  line,
  numberField,
  pageCount,
  quoted,
  shortCommit,
  stringField,
  type GenerationLogLine,
} from "./lines";
import { progressLine } from "./progress-lines";

/**
 * The generation log that people see: the stored job events, rewritten. The
 * stored events stay as they are, with the models, budgets, fingerprints and
 * ids that the pipeline records. This view keeps only what a person needs
 * from a run: its steps, retries, cache reuse, warnings and the outcome.
 *
 * Each kept event keeps its id, sequence and type. Its message is rewritten,
 * its `data` is dropped except the fields that its rule keeps, and it gets a
 * `phase` and a `level`. An event type that no rule names is hidden, so a new
 * internal event never reaches people.
 */
export function toGenerationLog(events: readonly JobEventDto[]): JobEventDto[] {
  return events.flatMap((event) => {
    const logEvent = toGenerationLogEvent(event);
    return logEvent ? [logEvent] : [];
  });
}

/** The generation log line of one stored event, or null when the log hides it. */
export function toGenerationLogEvent(event: JobEventDto): JobEventDto | null {
  const rule = EVENT_RULES[event.type];
  const logLine = rule ? rule(event.data ?? {}, event.message) : hidden;
  if (!logLine) return null;
  const elapsedMs = numberField(event.data ?? {}, "elapsedMs");
  const data = {
    ...(logLine.data ?? {}),
    ...(elapsedMs === null ? {} : { elapsedMs }),
  };
  return {
    id: event.id,
    jobId: event.jobId,
    sequence: event.sequence,
    source: event.source,
    type: event.type,
    message: logLine.message,
    data: Object.keys(data).length === 0 ? null : data,
    createdAt: event.createdAt,
    phase: logLine.phase,
    level: logLine.level,
  };
}

type EventRule = (data: Record<string, unknown>, message: string) => GenerationLogLine | null;

/** Why a retry from the pull request check did not start, by its stored code. */
const RETRY_REFUSAL_TEXT: Partial<Record<string, string>> = {
  not_permitted: "only people who can push to the repository can start it.",
  permission_unknown: "GitHub did not confirm the person's access. Try again.",
  already_active: "a preview of this pull request is already running.",
  not_finished: "this preview is still running.",
  superseded: "a newer push replaced this preview.",
  change_not_open: "the pull request is closed or is a draft.",
  base_not_production: "the pull request no longer targets the production branch.",
  billing_refused: "the account has no AI credits left.",
  paused: "new generations are paused for now.",
};

const EVENT_RULES: Record<string, EventRule> = {
  // The run
  queued: () => line("run", "Generation queued."),
  doxabot_queued: (data) => {
    if (stringField(data, "rerunOfJobId")) {
      return line("run", "Doxabot queued the preview again from an earlier run.");
    }
    const revision = stringField(data, "targetRevision");
    return line(
      "run",
      revision
        ? `Doxabot queued a preview for commit ${shortCommit(revision)}.`
        : "Doxabot queued a preview.",
    );
  },
  running: () => line("run", "Generation started."),
  failed: () => line("run", "Generation failed.", "error"),
  user_cancel_requested: (_, message) =>
    line("run", message === "Cancelled by an agent." ? message : "Cancelled by a user.", "warning"),
  admin_cancel_requested: () => line("run", "Cancelled by the Doxa team.", "warning"),
  generation_cancelled: () => line("run", "Generation cancelled.", "warning"),
  generation_paused: () => line("run", "New generations are paused for now.", "warning"),
  doxabot_superseded: () =>
    line("run", "A newer push to the pull request replaced this preview."),
  watchdog_cancelled: () =>
    line("run", "The generation waited too long to start and was cancelled.", "error"),
  watchdog_failed: () =>
    line("run", "The generation took too long and was stopped.", "error"),
  container_timed_out: timedOut,
  container_idle_timed_out: timedOut,
  container_stage_timed_out: timedOut,
  workflow_step_failed: (data) =>
    line(
      "run",
      data.resumable === true
        ? "The run stopped. You can continue it from where it stopped."
        : "The run stopped.",
      "error",
    ),
  generation_resumed: () => line("run", "Continuing the run from where it stopped."),
  generation_resume_failed: () =>
    line("run", "The run could not continue from where it stopped.", "error"),
  rerun_started: () => line("run", "This generation was started again as a new run."),
  rerun_of: () => line("run", "Started again from an earlier generation."),
  generation_stage_attempt_retrying: (data) =>
    line(stagePhase(data.stage), `${stageStep(data.stage)} failed. Trying it again.`, "warning"),
  generation_stage_attempt_failed: (data) =>
    line(stagePhase(data.stage), `${stageStep(data.stage)} failed.`, "error"),
  review_run_create_failed: () =>
    line(
      "run",
      "Doxabot could not create the check on the pull request. The preview continues.",
      "warning",
    ),
  review_run_update_failed: () =>
    line("run", "Doxabot could not update the check on the pull request.", "warning"),
  doxabot_retry_requested: (data) => {
    const login = stringField(data, "login");
    return line(
      "run",
      login
        ? `@${login} asked on the pull request to run this preview again.`
        : "Someone asked on the pull request to run this preview again.",
    );
  },
  doxabot_retry_refused: (data) => {
    const reason = RETRY_REFUSAL_TEXT[stringField(data, "reason") ?? ""];
    return line(
      "run",
      reason ? `Doxabot did not run this preview again: ${reason}` : "Doxabot did not run this preview again.",
      "warning",
    );
  },

  // Credits (billing spec 10.5 and 10.6)
  [GENERATION_CREDITS_EVENT_TYPE]: creditsLine,
  [GENERATION_CREDITS_STOPPED_EVENT_TYPE]: creditsStoppedLine,

  // Setup
  preview_workflow_started: (data) =>
    line(
      "setup",
      data.baselineVersionId
        ? "Updating the preview from the published docs."
        : "Generating a preview of the docs.",
    ),
  production_workflow_started: (data) =>
    line(
      "setup",
      data.baselineVersionId
        ? "Updating the published docs."
        : "Generating the docs for the first time.",
    ),
  snapshot_started: (data, message) => {
    if (!isFirstStage(data)) return hidden;
    const repository = /for (.+)\.$/.exec(message)?.[1];
    const revision = stringField(data, "targetRevision");
    const source = repository ? `the source code of ${repository}` : "the source code";
    return line(
      "setup",
      revision
        ? `Getting ${source} at commit ${shortCommit(revision)}.`
        : `Getting ${source}.`,
    );
  },
  snapshot_complete: (data) => (isFirstStage(data) ? line("setup", "Source code ready.") : hidden),
  snapshot_retrying: (data) => {
    const attempt = numberField(data, "nextAttempt");
    const max = numberField(data, "maxAttempts");
    return line(
      "setup",
      attempt !== null && max !== null
        ? `Getting the source code failed. Trying again (${attemptText(attempt, max)}).`
        : "Getting the source code failed. Trying again.",
      "warning",
    );
  },
  snapshot_merge_conflict: () =>
    line(
      "setup",
      "The pull request cannot be merged cleanly with its base branch. Resolve the conflicts and push again.",
      "error",
    ),
  clone_started: (data, message) => {
    if (!isFirstStage(data)) return hidden;
    const repository = stringField(data, "repositoryFullName") ?? /^Cloning (.+)\.$/.exec(message)?.[1];
    return line("setup", repository ? `Getting the source code of ${repository}.` : "Getting the source code.");
  },
  clone_complete: (data) => (isFirstStage(data) ? line("setup", "Source code ready.") : hidden),

  // Analysis
  analysis_started: () => line("analyze", "Analyzing the repository."),
  analysis_progress: (data, message) => progressLine(message, data),
  repo_map_ready: (data) => {
    const files = numberField(data, "fileCount");
    if (files === null) return hidden;
    return line(
      "analyze",
      data.cacheHit === true
        ? `Reused the file map of an earlier run (${files} files).`
        : `Mapped ${files} files of the repository.`,
    );
  },
  analysis_complete: (data) => {
    const reason = planReason(stringField(data, "reason"));
    return line("analyze", reason ? `Analysis done. ${reason}` : "Analysis done.");
  },
  api_reference_source: (_, message) =>
    line("analyze", message),
  project_instructions_applied: (_, message) =>
    line("analyze", message),
  // The worker writes this message from a fixed list, so it holds no internal detail.
  generation_context_unavailable: (_, message) => line("setup", message, "error"),

  // Plan
  plan_cache_hit: () => line("plan", "Reused the plan of an earlier run of the same code and settings."),
  structure_started: () => line("plan", "Planning the documentation structure."),
  structure_reused: (data) => {
    const pages = numberField(data, "pageCount");
    return line(
      "plan",
      pages === null
        ? "Reused the published structure."
        : `Reused the published structure: ${pageCount(pages)}.`,
    );
  },
  structure_patched: (data) => {
    const added = numberField(data, "addedPageCount") ?? 0;
    const removed = numberField(data, "removedPageCount") ?? 0;
    return line(
      "plan",
      `Updated the published structure for the new reference pages: ${added} added, ${removed} removed.`,
    );
  },
  structure_review_started: (data) => {
    const pages = numberField(data, "proposedPageCount");
    return line(
      "plan",
      pages === null
        ? "Reviewing the plan for readers."
        : `Reviewing the plan of ${pageCount(pages)} for readers.`,
    );
  },
  structure_pages_removed_by_instructions: (_, message) => line("plan", message, "warning"),
  structure_review_degraded: () =>
    line("plan", "The plan review did not finish. Using the best plan so far.", "warning"),
  structure_review_decided: (data) => line("plan", reviewDecisionText(data)),
  structure_reviewed: (data) => line("plan", reviewDecisionText(data)),
  structure_created: (data) => {
    const pages = numberField(data, "pageCount");
    const sections = numberField(data, "sectionCount");
    const structure = pages === null
      ? "Structure ready."
      : `Structure ready: ${pageCount(pages)}${sections === null ? "" : ` in ${sections} ${sections === 1 ? "section" : "sections"}`}.`;
    const written = numberField(data, "regeneratePageCount");
    const reused = numberField(data, "reusePageCount");
    if (written === null || reused === null || reused === 0) return line("plan", structure);
    return line(
      "plan",
      `${structure} ${capitalize(pageCount(written))} to write. ${capitalize(pageCount(reused))} stay as they are.`,
    );
  },
  stage_progress: (data, message) => progressLine(message, data),

  // Writing
  writing_started: (data) => {
    const pages = numberField(data, "pageCount");
    return line("write", pages === null ? "Writing the pages." : `Writing ${pageCount(pages)}.`);
  },
  page_write_completed: (data, message) => progressLine(message, data),
  page_written: (data) => {
    const title = stringField(data, "title");
    return title ? line("write", `Wrote ${quoted(title)}.`) : hidden;
  },
  page_write_failed: (data) => {
    const title = stringField(data, "title");
    return line(
      "write",
      title ? `${quoted(title)} could not be written.` : "A page could not be written.",
      "warning",
    );
  },
  page_cache_cross_model_hit: () => line("write", "Reused a page from an earlier run."),
  pages_written: (data) => {
    const pages = numberField(data, "pageCount");
    const failed = numberField(data, "failedPageCount") ?? 0;
    if (pages === null) return line("write", "Finished writing.");
    return line(
      "write",
      failed > 0
        ? `Finished: ${pageCount(pages)} written, ${failed} failed.`
        : `Finished: ${pageCount(pages)} written.`,
      failed > 0 ? "warning" : "info",
    );
  },
  page_cache_reused: (data) => {
    const cached = numberField(data, "cachedPageCount");
    const written = numberField(data, "writtenPageCount") ?? 0;
    if (cached === null || cached === 0) return hidden;
    const reason =
      "Their source files, plan, links and Doxabot instructions did not change, so Doxa did not write them again";
    return line(
      "write",
      written > 0
        ? `Reused ${pageCount(cached)} from earlier runs. ${reason}. Doxa wrote the other ${pageCount(written)}.`
        : `Reused ${pageCount(cached)} from earlier runs. ${reason}.`,
    );
  },
  generation_page_flagged: (_, message) => line("write", message, "warning"),
  generation_page_notice: (_, message) => line("write", message, "warning"),

  // Publication
  artifact_link_warning: (data) => {
    const page = stringField(data, "page");
    const route = stringField(data, "route");
    if (!page || !route) return hidden;
    return line(
      "publish",
      `The page ${page} links to ${route}, which is not in the navigation.`,
      "warning",
    );
  },
  published: (data) => line("publish", `Docs published${publishedCounts(data)}.`),
  preview_published: (data) => line("publish", `Preview published${publishedCounts(data)}.`),
  promoted: () => line("publish", "Promoted to production."),

  // Review
  staged_for_review: (data) => line("review", `The docs are ready for review${publishedCounts(data)}.`),
  review_ready: (data) => {
    const pages = numberField(data, "pageCount");
    return line(
      "review",
      pages === null
        ? "The review is ready."
        : `The review is ready: ${pageCount(pages)} changed.`,
    );
  },
  review_skipped: () =>
    line("review", "The generation changed no page, so there is nothing to review."),
};

/**
 * The live credit meter. A shadow event (`BILLING_ENFORCEMENT=shadow`) holds
 * nothing and is hidden, so shadow mode stays invisible to people.
 */
function creditsLine(data: Record<string, unknown>): GenerationLogLine | null {
  // The stored event may carry more fields; the strict schema reads only the meter's.
  const parsed = generationCreditsEventDataSchema.safeParse({
    usedCredits: data.usedCredits,
    jobUsedCredits: data.jobUsedCredits,
    holdCredits: data.holdCredits,
    capCredits: data.capCredits,
    fromPaygCredits: data.fromPaygCredits,
    shadow: data.shadow,
  });
  if (!parsed.success || parsed.data.shadow) return hidden;
  const credits = parsed.data;
  // The whole job: a continued run counts its earlier tries too.
  const jobUsedCredits = credits.jobUsedCredits ?? credits.usedCredits;
  return {
    ...line("run", `${creditCount(jobUsedCredits)} used so far.`),
    data: {
      usedCredits: credits.usedCredits,
      jobUsedCredits,
      holdCredits: credits.holdCredits,
      capCredits: credits.capCredits,
      fromPaygCredits: credits.fromPaygCredits,
      shadow: credits.shadow,
    },
  };
}

/** A run that the credit meter (or a billing refusal) ended as `stopped_credits`. */
function creditsStoppedLine(data: Record<string, unknown>): GenerationLogLine {
  const parsed = generationCreditsStoppedEventDataSchema.safeParse(data);
  if (!parsed.success) return line("run", "The run stopped for AI credits.", "warning");
  const { reason, finishedPageCount } = parsed.data;
  const finished = finishedPageCount === undefined
    ? ""
    : ` ${capitalize(pageCount(finishedPageCount))} ${finishedPageCount === 1 ? "is" : "are"} finished.`;
  return {
    ...line("run", `${CREDIT_STOP_TEXT[reason]}${finished}`, "warning"),
    data: { reason, ...(finishedPageCount === undefined ? {} : { finishedPageCount }) },
  };
}

const CREDIT_STOP_TEXT: Record<
  ReturnType<typeof generationCreditsStoppedEventDataSchema.parse>["reason"],
  string
> = {
  credits_exhausted: "The run stopped because the AI credits ran out.",
  credit_cap: "The run stopped at its credit cap.",
  plan_limit: "The plan does not include this AI action, so the run stopped.",
  model_unpriced: "The run stopped because Doxa could not meter its model.",
  ai_paused_for_review: "AI runs of this account are paused for a review, so the run stopped.",
};

function creditCount(value: number): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? "credit" : "credits"}`;
}

function timedOut(): GenerationLogLine {
  return line("run", "A step took too long and was stopped.", "error");
}

/**
 * True for the events of the first container stage. Every write group starts
 * its own container and prepares the same source again, so only the first
 * preparation is shown.
 */
function isFirstStage(data: Record<string, unknown>): boolean {
  return data.stage === undefined || data.stage === "plan" || data.stage === "analysis";
}

function stagePhase(stage: unknown): GenerationLogPhase {
  switch (stage) {
    case "analysis":
      return "analyze";
    case "plan":
    case "structure":
      return "plan";
    case "write":
      return "write";
    default:
      return "run";
  }
}

function stageStep(stage: unknown): string {
  switch (stage) {
    case "analysis":
      return "The analysis step";
    case "plan":
    case "structure":
      return "The planning step";
    case "write":
      return "A writing step";
    default:
      return "A step";
  }
}

function reviewDecisionText(data: Record<string, unknown>): string {
  const counts: [string, number | null][] = [
    ["kept", numberField(data, "keepCount")],
    ["merged", numberField(data, "mergeCount")],
    ["moved", numberField(data, "moveCount")],
    ["removed", numberField(data, "dropCount")],
  ];
  const parts = counts.flatMap(([verb, count]) =>
    count !== null && count > 0 ? [`${verb} ${pageCount(count)}`] : [],
  );
  if (parts.length === 0) return "The review checked every page.";
  return `The review ${joinWords(parts)}.`;
}

/**
 * The pages of the run, and the pages kept from the published docs. A page of
 * the run is one that the writer wrote or that came from the page cache
 * (`page_cache_reused`), so the text does not say "written".
 */
function publishedCounts(data: Record<string, unknown>): string {
  const fromRun = numberField(data, "regeneratedPageCount");
  const kept = numberField(data, "reusedPageCount");
  if (fromRun === null) return "";
  return kept === null
    ? `: ${pageCount(fromRun)} from this run`
    : `: ${pageCount(fromRun)} from this run, ${kept} kept from the published docs`;
}

/**
 * The reasons that the revision-aware planner gives for how much of a run it
 * reuses (`packages/agent/src/state/planning.ts` and the agent container), in
 * words for people. A reason that is not here is left out.
 */
const PLAN_REASONS: readonly [RegExp, (match: RegExpExecArray) => string][] = [
  [/^No compatible published generation state is available\.$/, () =>
    "There are no published docs to reuse, so the full repository was analyzed."],
  [/^The documentation planning contract changed\.$/, () =>
    "Doxa changed how it plans docs, so the docs are planned again."],
  [/^The writer contract changed/, () =>
    "Doxa changed how it writes pages, so every page is written again."],
  [/^Documentation-relevant source changes are not mapped to prior page dependencies\.$/, () =>
    "The source changes do not map to known pages, so the docs are planned again."],
  [/^The reusable analysis cache cannot/, () =>
    "The earlier analysis cannot be reused, so the repository is analyzed again."],
  [/^(\d+) page\(s\) have new page inputs; source changes do not affect the others\.$/, ([, count]) =>
    `${capitalize(pageCount(count))} have new inputs. The source changes do not affect the other pages.`],
  [/^All current pages match the published page inputs and dependencies\.$/, () =>
    "All pages match the published docs."],
  [/^Source changes do not affect published documentation\.$/, () =>
    "The source changes do not affect the published docs."],
  [/^Routes or schemas changed/, () =>
    "Routes or schemas changed, so the published structure gets an update."],
  [/^A package was added or removed/, () =>
    "The project layout changed, so the docs are planned again."],
  [/^The structural source fingerprint changed\.$/, () =>
    "The project layout changed, so the docs are planned again."],
  [/^Page .+ is new\.$/, () => "New pages were added to the plan."],
  [/^Page .+ inputs changed\.$/, () => "Some pages have new inputs."],
  [/^Page .+ depends on changed source/, () => "Some pages depend on source code that changed."],
];

function planReason(reason: string | null): string | null {
  if (!reason) return null;
  for (const [pattern, text] of PLAN_REASONS) {
    const match = pattern.exec(reason);
    if (match) return text(match);
  }
  return null;
}

function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
