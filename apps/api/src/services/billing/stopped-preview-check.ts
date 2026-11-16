import type { GenerationStopReason } from "@doxahq/contracts";
import type { Env } from "../../env";
import { STOPPED_CREDITS_CHECK, type ReviewRunsService } from "../doxabot/review-runs";
import { billingConfigFor, isBillingActive } from "./config";
import { billingCoreFromEnv } from "./core";

interface StoppedCheckJobs {
  findProjectId(jobId: string): Promise<string | null>;
  addEvent(jobId: string, type: string, message: string, data?: Record<string, unknown>): Promise<unknown>;
}

/**
 * The billing page of the account that pays for a project, or null. A link
 * only: a billing error gives null, never a failed check.
 */
export async function billingPageUrlForProject(env: Env, projectId: string): Promise<string | null> {
  const config = billingConfigFor(env);
  const base = config.returnBaseUrl;
  if (!isBillingActive(config)) return null;
  try {
    const account = await billingCoreFromEnv(env).accounts.resolveBillingAccount(projectId);
    return `${base}/dashboard/billing/${encodeURIComponent(account.id)}`;
  } catch {
    return `${base}/dashboard`;
  }
}

/**
 * Billing spec 10.6: the pull request check of a preview that AI credits
 * stopped finishes `neutral` with "AI credits ran out" and a billing link,
 * so it never fails the customer's CI. A production run has no check, so
 * this does nothing for it. A GitHub failure is recorded, never thrown.
 */
export async function closeStoppedPreviewCheck(
  env: Env,
  jobs: StoppedCheckJobs,
  checks: Pick<ReviewRunsService, "finish">,
  input: { jobId: string; reason: GenerationStopReason },
): Promise<void> {
  try {
    const projectId = await jobs.findProjectId(input.jobId);
    const detailsUrl = projectId ? await billingPageUrlForProject(env, projectId) : null;
    const summary =
      input.reason === "credit_cap"
        ? "Doxa stopped the documentation preview because the run reached its credit cap. Raise the cap on the billing page, then run the preview again."
        : STOPPED_CREDITS_CHECK.summary;
    await checks.finish(input.jobId, "neutral", {
      title: input.reason === "credit_cap" ? "Credit cap reached" : STOPPED_CREDITS_CHECK.title,
      summary,
      detailsUrl,
    });
  } catch (error) {
    await jobs
      .addEvent(input.jobId, "review_run_update_failed", "Doxabot could not mark the pull request check as stopped for credits.", {
        error: error instanceof Error ? error.message : "Unknown error.",
      })
      .catch(() => undefined);
  }
}
