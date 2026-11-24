import type {
  DoxabotEligibility,
  DoxabotUnavailableReason,
  RepositoryVisibility,
} from "@doxahq/contracts";
import type { Env } from "../../env";
import type { RepositoryConnectionIssue } from "../../repositories/github-lifecycle";

export interface DoxabotDeploymentPolicy {
  enabled: boolean;
  publicRepositoriesEnabled: boolean;
}

export type DoxabotRepositoryState =
  | { connected: false }
  | {
      connected: true;
      visibility: RepositoryVisibility;
      /**
       * Set when GitHub took the repository away: the app lost it, or the
       * installation is suspended or uninstalled. Doxabot cannot run then.
       */
      connectionIssue?: RepositoryConnectionIssue | null;
    };

export interface EvaluateDoxabotEligibilityInput {
  deploymentPolicy: DoxabotDeploymentPolicy;
  repository: DoxabotRepositoryState;
  hasPublishedVersion: boolean;
  storedEnabled: boolean;
}

type DoxabotPolicyEnv = Pick<
  Env,
  "DOXABOT_ENABLED" | "DOXABOT_PUBLIC_REPOSITORIES_ENABLED"
>;

export function resolveDoxabotDeploymentPolicy(
  env: DoxabotPolicyEnv,
): DoxabotDeploymentPolicy {
  return {
    enabled: parseBooleanFlag(env.DOXABOT_ENABLED),
    publicRepositoriesEnabled: parseBooleanFlag(
      env.DOXABOT_PUBLIC_REPOSITORIES_ENABLED,
    ),
  };
}

export function evaluateDoxabotEligibility(
  input: EvaluateDoxabotEligibilityInput,
): DoxabotEligibility {
  if (!input.deploymentPolicy.enabled) {
    return unavailable("global_disabled");
  }
  if (!input.repository.connected || input.repository.connectionIssue) {
    return unavailable("repository_not_connected");
  }
  // The kill switch of the public repository rollout. Remove it, and the
  // `public_repository_disabled` reason, after the rollout.
  if (
    input.repository.visibility === "public"
    && !input.deploymentPolicy.publicRepositoriesEnabled
  ) {
    return unavailable("public_repository_disabled");
  }
  if (!input.hasPublishedVersion) {
    return unavailable("initial_generation_required");
  }

  return {
    available: true,
    enabled: input.storedEnabled,
    reason: null,
  };
}

function unavailable(reason: DoxabotUnavailableReason): DoxabotEligibility {
  return {
    available: false,
    enabled: false,
    reason,
  };
}

function parseBooleanFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}
