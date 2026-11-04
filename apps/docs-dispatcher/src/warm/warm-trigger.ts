import type {
  DocsWarmHint,
  DocsWarmMessage,
} from "@doxahq/contracts/docs-warm-job";
import { DOCS_WARM_MESSAGE_HOSTNAME_LIMIT } from "@doxahq/contracts/docs-warm-job";

import type { HostnameMapLiveChange } from "../hostname-map";
import { isWarmSite, type WarmConfig } from "./warm-config";
import { describeWarmError } from "./warm-log";

/**
 * The publish trigger (M28): `syncHostnames` reports every hostname whose
 * live resolution changed; this groups them by site and sends one publish
 * message per site. The warm hint orders the job and never selects it.
 * A failed send is logged and never fails the sync: visitors still render.
 */
export interface PublishTriggerInput {
  changes: readonly HostnameMapLiveChange[];
  hint: DocsWarmHint | undefined;
  config: WarmConfig;
  releaseId: string | null;
  queue: { sendBatch(messages: { body: DocsWarmMessage }[]): Promise<unknown> } | undefined;
  createJobId(): string;
  now: number;
}

export interface PublishTriggerResult {
  /** Sites that got a message. */
  warmEnqueued: number;
  /** Why nothing was sent, when nothing was. */
  skipped?: "off" | "no_queue" | "no_release" | "no_change" | "send_failed";
  error?: string;
}

const RELEASE_ID_PATTERN = /^[a-f0-9]{64}$/;

export async function enqueuePublishWarm(
  input: PublishTriggerInput,
): Promise<PublishTriggerResult> {
  if (input.config.rollout.mode === "off") return { warmEnqueued: 0, skipped: "off" };
  if (!input.queue) return { warmEnqueued: 0, skipped: "no_queue" };
  const releaseId = input.releaseId;
  if (!releaseId || !RELEASE_ID_PATTERN.test(releaseId)) {
    return { warmEnqueued: 0, skipped: "no_release" };
  }
  const messages = groupBySite(input.changes)
    .filter(({ siteId }) => isWarmSite(input.config, siteId))
    .map(
      ({ siteId, changes }): DocsWarmMessage => ({
        v: 1,
        reason: "publish",
        siteId,
        hostnames: changes
          .map((change) => change.hostname)
          .slice(0, DOCS_WARM_MESSAGE_HOSTNAME_LIMIT),
        releaseId,
        ...newestVersion(changes),
        jobId: input.createJobId(),
        ...(input.hint ? { priority: input.hint } : {}),
        enqueuedAt: input.now,
      }),
    );
  if (messages.length === 0) return { warmEnqueued: 0, skipped: "no_change" };
  try {
    await input.queue.sendBatch(messages.map((body) => ({ body })));
    return { warmEnqueued: messages.length };
  } catch (error) {
    return { warmEnqueued: 0, skipped: "send_failed", error: describeWarmError(error) };
  }
}

function groupBySite(
  changes: readonly HostnameMapLiveChange[],
): { siteId: string; changes: HostnameMapLiveChange[] }[] {
  const sites = new Map<string, HostnameMapLiveChange[]>();
  for (const change of changes) {
    const siteId = change.resolution.siteId;
    sites.set(siteId, [...(sites.get(siteId) ?? []), change]);
  }
  return [...sites].map(([siteId, siteChanges]) => ({ siteId, changes: siteChanges }));
}

/** The version of the newest change: the consumer waits until KV shows it. */
function newestVersion(
  changes: readonly HostnameMapLiveChange[],
): { publishedVersionId?: string } {
  const newest = [...changes].sort((left, right) => right.resolvedAt - left.resolvedAt)[0];
  return newest ? { publishedVersionId: newest.resolution.publishedVersionId } : {};
}
