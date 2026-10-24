import {
  DEFAULT_RETENTION_POLICY,
  mergeRetentionPolicy,
  type RetentionPolicy,
  type RetentionPolicyOverrides,
} from "@doxahq/contracts/retention-policy";

/**
 * The project facts that decide its retention policy. Plans do not exist
 * yet, so no project carries overrides today. A plan lookup will fill
 * `retentionOverrides` later.
 */
export interface RetentionPolicyProject {
  id: string;
  retentionOverrides?: RetentionPolicyOverrides | null;
}

/**
 * The one place that turns a project into its retention policy. Collectors
 * and the Promote rule call it when they decide, never the defaults.
 */
export function resolveRetentionPolicy(
  project: RetentionPolicyProject,
): RetentionPolicy {
  return mergeRetentionPolicy(
    DEFAULT_RETENTION_POLICY,
    project.retentionOverrides,
  );
}
