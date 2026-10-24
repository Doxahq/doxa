import type { DoxabotMergeTrigger } from "@doxahq/contracts";
import type { Env } from "../../env";
import {
  PendingMergesRepository,
  type MergeCandidate,
  type PendingMergesStore,
} from "../../repositories/pending-merges";
import {
  GenerationStartService,
  type GenerationStartOutcome,
} from "../generation-start";

const MINUTE_MS = 60_000;

/** Starts a production run for a project on behalf of its owner. */
export type MergeGenerationStarter = (input: {
  projectId: string;
  ownerUserId: string;
}) => Promise<GenerationStartOutcome["outcome"]>;

/** A start that met another run; the scheduler tries again on its next tick. */
const RETRY_OUTCOMES: ReadonlySet<GenerationStartOutcome["outcome"]> = new Set([
  "already_active",
  "active_conflict",
]);

/**
 * True when merged pull requests should start a run now. A batched trigger
 * waits until no pull request merged for the quiet time.
 */
export function isMergeRunDue(candidate: MergeCandidate, now: Date): boolean {
  if (candidate.mergeTrigger === "every_merge") return true;
  const quietUntil =
    candidate.lastMergedAt.getTime() + candidate.batchQuietMinutes * MINUTE_MS;
  return quietUntil <= now.getTime();
}

/**
 * Turns merged pull requests into production runs, as the Doxabot merge
 * trigger asks. Every run goes to a generation review, so a run never changes
 * the live site by itself. The API cron calls `run`; the webhook calls
 * `recordMerge`.
 */
export class MergeGenerationScheduler {
  constructor(
    private readonly deps: {
      merges: Pick<PendingMergesStore, "record" | "candidates" | "markAttempted">;
      start: MergeGenerationStarter;
      now?: () => Date;
    },
  ) {}

  static fromEnv(
    env: Env,
    defer: (promise: Promise<unknown>) => void,
  ): MergeGenerationScheduler {
    return new MergeGenerationScheduler({
      merges: new PendingMergesRepository(env),
      start: async ({ projectId, ownerUserId }) =>
        (
          await GenerationStartService.fromEnv(env, { defer }).start({
            userId: ownerUserId,
            projectId,
            force: false,
            trigger: "merge",
          })
        ).outcome,
    });
  }

  /** Starts a run for every project whose merges are due. */
  async run(): Promise<number> {
    const now = this.now();
    const due = (await this.deps.merges.candidates()).filter((candidate) =>
      isMergeRunDue(candidate, now),
    );
    let started = 0;
    for (const candidate of due) {
      if (await this.attempt(candidate, now)) started += 1;
    }
    return started;
  }

  /**
   * Records a merged pull request. With the `every_merge` trigger, the run
   * starts at once; the other triggers wait for the cron.
   */
  async recordMerge(input: {
    projectId: string;
    mergeTrigger: DoxabotMergeTrigger;
    changeExternalId: string;
    changeNumber: number;
    mergedAt: Date;
  }): Promise<void> {
    await this.deps.merges.record({
      projectId: input.projectId,
      changeExternalId: input.changeExternalId,
      changeNumber: input.changeNumber,
      mergedAt: input.mergedAt,
    });
    if (input.mergeTrigger !== "every_merge") return;

    const now = this.now();
    const candidate = (await this.deps.merges.candidates()).find(
      (entry) => entry.projectId === input.projectId,
    );
    if (candidate) await this.attempt(candidate, now);
  }

  /**
   * Starts one run. Merges that the start answered stay tried, so a start
   * that needs a person (for example the first run over hand-written pages)
   * does not repeat on every tick; a newer merge tries again.
   */
  private async attempt(candidate: MergeCandidate, now: Date): Promise<boolean> {
    const outcome = await this.deps.start({
      projectId: candidate.projectId,
      ownerUserId: candidate.ownerUserId,
    });
    if (RETRY_OUTCOMES.has(outcome)) return false;

    await this.deps.merges.markAttempted({
      projectId: candidate.projectId,
      until: now,
    });
    return outcome === "started";
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
