import { ORIGIN_KEY_HEADER, secretsMatch } from "@doxahq/api-bridge";
import { z } from "zod";
import type { Env } from "../../env";
import { runScheduledJobs } from "../../scheduled";
import { BackgroundTasks } from "./background-tasks";

const cronTickSchema = z.object({ scheduledTime: z.number().int().nonnegative() });

export type RunJobs = (scheduledTime: number, env: Env, context: ExecutionContext) => void;

/** Runs `work` while this process holds the cron lock. Resolves false, without running it, when another holds it. */
export type WithCronLock = (env: Env, work: () => Promise<void>) => Promise<boolean>;

export interface CronHandlerDeps {
  env: Env;
  originKey: string;
  /** Process-wide work that shutdown waits for. */
  tasks: BackgroundTasks;
  /** Runs the jobs of one tick. Tests replace it. */
  runJobs?: RunJobs;
  /** The lock that one tick holds, so two tasks never run the jobs at once (see `cron-lease.ts`). */
  withLock: WithCronLock;
}

/**
 * Serves `POST /__cron`: the edge Worker's 5-minute tick. It answers at once
 * with 202 and runs the jobs in the background. A tick is skipped when the
 * previous tick still runs here, or when another task holds the lock.
 */
export function createCronHandler(deps: CronHandlerDeps): (request: Request) => Promise<Response> {
  const runJobs = deps.runJobs ?? runScheduledJobs;
  const withLock = deps.withLock;
  let running: Promise<void> | null = null;

  return async (request) => {
    if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });
    if (!secretsMatch(request.headers.get(ORIGIN_KEY_HEADER), deps.originKey)) {
      return new Response("Unauthorized.", { status: 401 });
    }
    const tick = cronTickSchema.safeParse(await request.json().catch(() => null));
    if (!tick.success) return new Response("The body must be { scheduledTime }.", { status: 400 });

    if (running) return Response.json({ status: "skipped", reason: "previous tick still running" }, { status: 202 });

    const { scheduledTime } = tick.data;
    running = withLock(deps.env, () => runTick(scheduledTime, deps.env, runJobs))
      .then((ran) => {
        if (!ran) console.info("Cron tick skipped: another task runs the jobs.");
      })
      .finally(() => {
        running = null;
      });
    deps.tasks.track(running);
    return Response.json({ status: "started" }, { status: 202 });
  };
}

/** Runs the jobs of one tick and waits for all of them, also work that they start. */
async function runTick(scheduledTime: number, env: Env, runJobs: RunJobs): Promise<void> {
  const jobs = new BackgroundTasks();
  runJobs(scheduledTime, env, jobs.createExecutionContext());
  await jobs.settled();
}
