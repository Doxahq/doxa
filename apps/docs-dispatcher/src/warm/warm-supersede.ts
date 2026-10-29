import type { DocsDomainResolution } from "@doxahq/contracts";

import type { HostnameMapEntryLookup } from "../hostname-map";
import { isWarmSite, type WarmConfig } from "./warm-config";
import type { WarmJob } from "./warm-job";

export type SupersedeReason =
  | "rollout_off"
  | "release_changed"
  | "hostname_removed"
  | "version_changed";

/**
 * Should a running warm job stop? A newer publish, a removed hostname or a
 * renderer deploy makes its keys useless; a rollback of the warm flag stops
 * it too. A newer `resolvedAt` with the same version (the API's 12-hour
 * rewrite) is not a change. Read errors keep the job running.
 */
export async function findSupersedeReason(
  job: WarmJob,
  input: {
    config: WarmConfig;
    deployedReleaseId: string | null;
    readEntry(hostname: string): Promise<HostnameMapEntryLookup>;
  },
): Promise<SupersedeReason | null> {
  if (!isWarmSite(input.config, job.siteId)) return "rollout_off";
  if (input.deployedReleaseId !== job.releaseId) return "release_changed";
  for (const target of job.targets) {
    const lookup = await input.readEntry(target.hostname);
    if (lookup.status === "miss") return "hostname_removed";
    if (
      lookup.status === "hit" &&
      lookup.entry.resolvedAt > target.resolvedAt &&
      !sameLiveVersion(lookup.entry.resolution, target.resolution)
    ) {
      return "version_changed";
    }
  }
  return null;
}

function sameLiveVersion(left: DocsDomainResolution, right: DocsDomainResolution): boolean {
  return (
    left.siteId === right.siteId &&
    left.publishedVersionId === right.publishedVersionId &&
    left.artifactPrefix === right.artifactPrefix &&
    left.manifestPath === right.manifestPath &&
    left.accessPolicy === right.accessPolicy
  );
}
