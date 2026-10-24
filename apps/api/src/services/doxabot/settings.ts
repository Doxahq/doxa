import type {
  DoxabotEligibility,
  DoxabotSettingsDto,
  DoxabotUnavailableReason,
  UpdateDoxabotSettingsInput,
} from "@doxahq/contracts";
import type { Env } from "../../env";
import {
  DoxabotSettingsRepository,
  type DoxabotProjectSettingsState,
  type DoxabotSettingsStore,
} from "../../repositories/doxabot-settings";
import {
  evaluateDoxabotEligibility,
  resolveDoxabotDeploymentPolicy,
  type DoxabotDeploymentPolicy,
} from "./eligibility";

export type DoxabotSettingsErrorCode =
  | "project_not_found"
  | "forbidden"
  | "enablement_unavailable";

export class DoxabotSettingsError extends Error {
  constructor(
    readonly code: DoxabotSettingsErrorCode,
    message: string,
    readonly unavailableReason: DoxabotUnavailableReason | null = null,
  ) {
    super(message);
    this.name = "DoxabotSettingsError";
  }
}

export class DoxabotSettingsService {
  constructor(
    private readonly settingsStore: DoxabotSettingsStore,
    private readonly deploymentPolicy: DoxabotDeploymentPolicy,
  ) {}

  static fromEnv(env: Env): DoxabotSettingsService {
    return new DoxabotSettingsService(
      new DoxabotSettingsRepository(env),
      resolveDoxabotDeploymentPolicy(env),
    );
  }

  async getForOwner(input: {
    projectId: string;
    userId: string;
  }): Promise<DoxabotSettingsDto> {
    const state = await this.getOwnedProjectState(input);
    return toSettingsDto(state, this.deploymentPolicy);
  }

  /**
   * `userId` is the project owner; `updatedByUserId` is the person who acts.
   * `changes` names only the settings that change.
   */
  async updateForOwner(input: {
    projectId: string;
    userId: string;
    updatedByUserId: string;
    changes: UpdateDoxabotSettingsInput;
  }): Promise<DoxabotSettingsDto> {
    const state = await this.getOwnedProjectState(input);
    const currentEligibility = eligibilityFor(state, this.deploymentPolicy);

    if (input.changes.enabled === true && !currentEligibility.available) {
      throw new DoxabotSettingsError(
        "enablement_unavailable",
        "Doxabot cannot be enabled for this project.",
        currentEligibility.reason,
      );
    }

    const updatedAt = await this.settingsStore.update({
      projectId: state.projectId,
      changes: input.changes,
      updatedByUserId: input.updatedByUserId,
    });

    return toSettingsDto(
      {
        ...state,
        storedEnabled: input.changes.enabled ?? state.storedEnabled,
        mergeTrigger: input.changes.mergeTrigger ?? state.mergeTrigger,
        batchQuietMinutes:
          input.changes.batchQuietMinutes ?? state.batchQuietMinutes,
        updatedAt,
      },
      this.deploymentPolicy,
    );
  }

  private async getOwnedProjectState(input: {
    projectId: string;
    userId: string;
  }): Promise<DoxabotProjectSettingsState> {
    const state = await this.settingsStore.getProjectState(input.projectId);
    if (!state) {
      throw new DoxabotSettingsError(
        "project_not_found",
        "Project not found.",
      );
    }
    if (state.ownerUserId !== input.userId) {
      throw new DoxabotSettingsError(
        "forbidden",
        "Project owner access required.",
      );
    }
    return state;
  }
}

function eligibilityFor(
  state: DoxabotProjectSettingsState,
  deploymentPolicy: DoxabotDeploymentPolicy,
): DoxabotEligibility {
  return evaluateDoxabotEligibility({
    deploymentPolicy,
    repository: state.repository,
    hasPublishedVersion: state.hasPublishedVersion,
    storedEnabled: state.storedEnabled,
  });
}

function toSettingsDto(
  state: DoxabotProjectSettingsState,
  deploymentPolicy: DoxabotDeploymentPolicy,
): DoxabotSettingsDto {
  const eligibility = eligibilityFor(state, deploymentPolicy);
  const settings = {
    enabled: state.storedEnabled,
    mergeTrigger: state.mergeTrigger,
    batchQuietMinutes: state.batchQuietMinutes,
    repositoryVisibility: state.repository.connected
      ? state.repository.visibility
      : null,
    updatedAt: state.updatedAt?.toISOString() ?? null,
  };

  return eligibility.available
    ? {
        ...settings,
        available: true,
        unavailableReason: null,
      }
    : {
        ...settings,
        available: false,
        unavailableReason: eligibility.reason,
      };
}
