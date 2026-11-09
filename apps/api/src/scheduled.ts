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
import { AgentSignupPurge } from "./services/agent-signup/agent-signup-purge";
import { isAgentSignupEnabled } from "./services/agent-signup/agent-signup-config";
import { resolveOAuthConfig } from "./services/oauth/oauth-config";
import { OAuthDataPurge } from "./services/oauth/purge";
import { createStorageGarbageCollector } from "./services/storage-gc";

/**
 * The jobs of one 5-minute cron tick. Each job runs in `waitUntil`, so a
 * failed job does not stop the others. The Worker runs them from
 * `scheduled()`, the Node server from the cron route.
 */
export function runScheduledJobs(scheduledTime: number, env: Env, context: ExecutionContext): void {
  context.waitUntil(DoxabotQueueOutboxPublisher.fromEnv(env).publishPending());
  context.waitUntil(DocsCacheInvalidationMaintenance.fromEnv(env).run());
  context.waitUntil(runHostnameMapReconcile(scheduledTime, env));
  context.waitUntil(DocsPrerenderTaskMaintenance.fromEnv(env).run());
  context.waitUntil(runDocsSearchMaintenance(scheduledTime, env));
  context.waitUntil(createStorageGarbageCollector(env).run());
  context.waitUntil(runDomainStatusChecks(env));
  context.waitUntil(runApprovalSweep(env, context));
  context.waitUntil(runMergeGenerations(env, context));
  const emailSweeper = EmailDeliverySweeper.fromEnv(env);
  if (emailSweeper) context.waitUntil(emailSweeper.run());
  const suppressionSync = isFirstCronRunOfHour(scheduledTime) ? EmailSuppressionSync.fromEnv(env) : null;
  if (suppressionSync) context.waitUntil(suppressionSync.run());
  if (resolveOAuthConfig(env).configured) {
    context.waitUntil(OAuthDataPurge.fromEnv(env).run());
  }
  if (isAgentSignupEnabled(env)) {
    context.waitUntil(AgentSignupPurge.fromEnv(env).run());
  }
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
