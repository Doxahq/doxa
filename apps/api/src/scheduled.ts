import type { Env } from "./env";
import { createAgentActionRuntime } from "./services/agent-actions/action-runtime";
import { DocsCacheInvalidationMaintenance } from "./services/docs-cache-invalidation-monitoring";
import { DocsDomainStatusChecks } from "./services/docs-domain-status-checks";
import { DocsHostnameMapReconciler } from "./services/docs-hostname-map";
import { DocsPrerenderTaskMaintenance } from "./services/docs-prerender-tasks";
import { runDocsSearchMaintenance } from "./services/docs-search/maintenance";
import { MergeGenerationScheduler } from "./services/doxabot/merge-generations";
import { DoxabotQueueOutboxPublisher } from "./services/doxabot/queue-outbox";
import { EmailDeliverySweeper } from "./services/email/email-delivery-sweeper";
import { EmailSuppressionSync, isFirstCronRunOfHour } from "./services/email/email-suppression-sync";
import { purgeAgentLiveEvents } from "./services/agent-live/agent-live-purge";
import { AgentSignupPurge } from "./services/agent-signup/agent-signup-purge";
import { isAgentSignupEnabled } from "./services/agent-signup/agent-signup-config";
import { resolveOAuthConfig } from "./services/oauth/oauth-config";
import { OAuthDataPurge } from "./services/oauth/purge";
import { createStorageGarbageCollector } from "./services/storage-gc";
import { reportCronHeartbeat } from "./services/cron-heartbeat";

/**
 * The jobs of one 5-minute cron tick. Each job runs in `waitUntil`, so a
 * failed job does not stop the others. The Worker runs them from
 * `scheduled()`, the Node server from the cron route.
 */
export function runScheduledJobs(scheduledTime: number, env: Env, context: ExecutionContext): void {
  const jobs: Promise<unknown>[] = [];
  const run = (job: Promise<unknown>) => {
    jobs.push(job);
    context.waitUntil(job);
  };
  run(DoxabotQueueOutboxPublisher.fromEnv(env).publishPending());
  run(DocsCacheInvalidationMaintenance.fromEnv(env).run());
  run(runHostnameMapReconcile(scheduledTime, env));
  run(DocsPrerenderTaskMaintenance.fromEnv(env).run());
  run(runDocsSearchMaintenance(scheduledTime, env));
  run(createStorageGarbageCollector(env).run());
  run(runDomainStatusChecks(env));
  run(runApprovalSweep(env, context));
  run(runMergeGenerations(env, context));
  const emailSweeper = EmailDeliverySweeper.fromEnv(env);
  if (emailSweeper) run(emailSweeper.run());
  const suppressionSync = isFirstCronRunOfHour(scheduledTime) ? EmailSuppressionSync.fromEnv(env) : null;
  if (suppressionSync) run(suppressionSync.run());
  if (resolveOAuthConfig(env).configured) {
    run(OAuthDataPurge.fromEnv(env).run());
  }
  if (isAgentSignupEnabled(env)) {
    run(AgentSignupPurge.fromEnv(env).run());
  }
  run(purgeAgentLiveEvents(env));
  run(runBillingJobs(scheduledTime, env));
  // Last, after every job of the tick: the uptime monitor's cron heartbeat.
  context.waitUntil(reportCronHeartbeat(env.OPENSTATUS_CRON_HEARTBEAT_URL, jobs));
}

/**
 * Billing spec 14.3. Only the Node origin has `BILLING_PAYMENTS`; it does
 * nothing with `BILLING_PROVIDER=none`. Async, so a failed setup rejects
 * this job only.
 */
async function runBillingJobs(scheduledTime: number, env: Env): Promise<unknown> {
  return env.BILLING_PAYMENTS?.forEnv(env).runScheduledJobs(scheduledTime);
}

/** Async, so a failed setup rejects this job only and the other jobs still run. */
async function runHostnameMapReconcile(scheduledTime: number, env: Env): Promise<unknown> {
  return DocsHostnameMapReconciler.fromEnv(env)?.run(scheduledTime);
}

/** Async, so a failed setup rejects this job only and the other jobs still run. */
async function runDomainStatusChecks(env: Env): Promise<unknown> {
  return DocsDomainStatusChecks.fromEnv(env)?.run();
}

/** Async, so a failed setup rejects this job only and the other jobs still run. */
async function runMergeGenerations(env: Env, context: ExecutionContext): Promise<unknown> {
  return MergeGenerationScheduler.fromEnv(env, (work) => context.waitUntil(work)).run();
}

/** Async, so a failed setup rejects this job only and the other jobs still run. */
async function runApprovalSweep(env: Env, context: ExecutionContext): Promise<unknown> {
  const runtime = createAgentActionRuntime(env, { defer: (work) => context.waitUntil(work) });
  return runtime.sweeper.run();
}
