import type { DoxabotDeploymentPolicy } from "../../src/services/doxabot/eligibility";
import type {
  DoxabotProjectSettingsState,
  DoxabotSettingsStore,
} from "../../src/repositories/doxabot-settings";
import type { ClaimWebhookDeliveryInput } from "../../src/repositories/webhook-deliveries";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
}));

vi.mock("@doxahq/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@doxahq/db")>();
  return { ...actual, createDb: mocks.createDb };
});

import { WebhookDeliveriesRepository } from "../../src/repositories/webhook-deliveries";
import { RepositoryBranchesUnavailableError } from "../../src/services/repository-branches";
import {
  DoxabotSettingsError,
  DoxabotSettingsService,
  type ProductionBranchCheck,
} from "../../src/services/doxabot/settings";

const enabledPolicy: DoxabotDeploymentPolicy = {
  enabled: true,
  publicRepositoriesEnabled: false,
};

const privateProject: DoxabotProjectSettingsState = {
  projectId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "owner-user",
  repository: {
    connected: true,
    visibility: "private",
    defaultBranch: "main",
    productionBranch: "main",
    connectionIssue: null,
  },
  hasPublishedVersion: true,
  storedEnabled: false,
  mergeTrigger: "batched",
  batchQuietMinutes: 30,
  allowedBotLogins: [],
  automationWarning: null,
  updatedAt: null,
};

/** Every branch exists, unless a test says otherwise. */
const existingBranches: ProductionBranchCheck = { exists: async () => true };

function settingsService(
  store: DoxabotSettingsStore,
  policy: DoxabotDeploymentPolicy,
  branchCheck: ProductionBranchCheck = existingBranches,
): DoxabotSettingsService {
  return new DoxabotSettingsService(store, policy, branchCheck);
}

function createSettingsStore(
  state: DoxabotProjectSettingsState | null,
): DoxabotSettingsStore & {
  getProjectState: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  getAutomationContext: ReturnType<typeof vi.fn>;
} {
  const getProjectState = vi.fn(async () => state);
  const update = vi.fn(async () => new Date("2026-07-23T09:00:00.000Z"));
  const getAutomationContext = vi.fn(async () => null);
  return { getProjectState, update, getAutomationContext };
}

describe("Doxabot settings service", () => {
  beforeEach(() => {
    mocks.createDb.mockReset();
  });

  test("returns stored settings with current private-repository eligibility", async () => {
    const store = createSettingsStore({
      ...privateProject,
      storedEnabled: true,
    });
    const service = settingsService(store, enabledPolicy);

    await expect(service.getForOwner({
      projectId: privateProject.projectId,
      userId: privateProject.ownerUserId,
    })).resolves.toEqual({
      available: true,
      enabled: true,
      mergeTrigger: "batched",
      batchQuietMinutes: 30,
      repositoryVisibility: "private",
      productionBranch: "main",
      repositoryDefaultBranch: "main",
      allowedBotLogins: [],
      automationWarning: null,
      unavailableReason: null,
      updatedAt: null,
    });
  });

  test("does not reveal settings to a non-owner", async () => {
    const store = createSettingsStore(privateProject);
    const service = settingsService(store, enabledPolicy);

    await expect(service.getForOwner({
      projectId: privateProject.projectId,
      userId: "another-user",
    })).rejects.toMatchObject({
      code: "forbidden",
      message: "Project owner access required.",
    });
    expect(store.update).not.toHaveBeenCalled();
  });

  test("requires an initial published generation before enablement", async () => {
    const store = createSettingsStore({
      ...privateProject,
      hasPublishedVersion: false,
    });
    const service = settingsService(store, enabledPolicy);

    await expect(service.updateForOwner({
      projectId: privateProject.projectId,
      userId: privateProject.ownerUserId,
      updatedByUserId: privateProject.ownerUserId,
      changes: { enabled: true },
    })).rejects.toEqual(expect.objectContaining({
      code: "enablement_unavailable",
      unavailableReason: "initial_generation_required",
    }));
    expect(store.update).not.toHaveBeenCalled();
  });

  test("rejects public-repository enablement while the rollout flag is off", async () => {
    const store = createSettingsStore({
      ...privateProject,
      repository: {
        connected: true,
        visibility: "public",
        defaultBranch: "main",
        productionBranch: "main",
        connectionIssue: null,
      },
    });
    const service = settingsService(store, enabledPolicy);

    await expect(service.updateForOwner({
      projectId: privateProject.projectId,
      userId: privateProject.ownerUserId,
      updatedByUserId: privateProject.ownerUserId,
      changes: { enabled: true },
    })).rejects.toEqual(expect.objectContaining({
      code: "enablement_unavailable",
      unavailableReason: "public_repository_disabled",
    }));
    expect(store.update).not.toHaveBeenCalled();
  });

  test("rejects enablement during a global shutdown", async () => {
    const store = createSettingsStore(privateProject);
    const service = settingsService(store, {
      ...enabledPolicy,
      enabled: false,
    });

    await expect(service.updateForOwner({
      projectId: privateProject.projectId,
      userId: privateProject.ownerUserId,
      updatedByUserId: privateProject.ownerUserId,
      changes: { enabled: true },
    })).rejects.toEqual(expect.objectContaining({
      code: "enablement_unavailable",
      unavailableReason: "global_disabled",
    }));
    expect(store.update).not.toHaveBeenCalled();
  });

  test("enables an eligible private project", async () => {
    const store = createSettingsStore(privateProject);
    const service = settingsService(store, enabledPolicy);

    await expect(service.updateForOwner({
      projectId: privateProject.projectId,
      userId: privateProject.ownerUserId,
      updatedByUserId: privateProject.ownerUserId,
      changes: { enabled: true },
    })).resolves.toEqual({
      available: true,
      enabled: true,
      mergeTrigger: "batched",
      batchQuietMinutes: 30,
      repositoryVisibility: "private",
      productionBranch: "main",
      repositoryDefaultBranch: "main",
      allowedBotLogins: [],
      automationWarning: null,
      unavailableReason: null,
      updatedAt: "2026-07-23T09:00:00.000Z",
    });
    expect(store.update).toHaveBeenCalledWith({
      projectId: privateProject.projectId,
      changes: { enabled: true },
      updatedByUserId: privateProject.ownerUserId,
    });
  });

  test("allows disabling after the deployment policy becomes unavailable", async () => {
    const store = createSettingsStore({
      ...privateProject,
      storedEnabled: true,
    });
    const service = settingsService(store, {
      ...enabledPolicy,
      enabled: false,
    });

    await expect(service.updateForOwner({
      projectId: privateProject.projectId,
      userId: privateProject.ownerUserId,
      updatedByUserId: privateProject.ownerUserId,
      changes: { enabled: false },
    })).resolves.toEqual({
      available: false,
      enabled: false,
      mergeTrigger: "batched",
      batchQuietMinutes: 30,
      repositoryVisibility: "private",
      productionBranch: "main",
      repositoryDefaultBranch: "main",
      allowedBotLogins: [],
      automationWarning: null,
      unavailableReason: "global_disabled",
      updatedAt: "2026-07-23T09:00:00.000Z",
    });
    expect(store.update).toHaveBeenCalledWith({
      projectId: privateProject.projectId,
      changes: { enabled: false },
      updatedByUserId: privateProject.ownerUserId,
    });
  });
});

test("records the member who changed the setting, not the project owner", async () => {
  const store = createSettingsStore(privateProject);
  const service = settingsService(store, {
    ...enabledPolicy,
    enabled: false,
  });

  await service.updateForOwner({
    projectId: privateProject.projectId,
    userId: privateProject.ownerUserId,
    updatedByUserId: "team-admin-1",
    changes: { enabled: false },
  });
  expect(store.update).toHaveBeenCalledWith(
    expect.objectContaining({ updatedByUserId: "team-admin-1" }),
  );
});

describe("Doxabot repository idempotency", () => {
  beforeEach(() => {
    mocks.createDb.mockReset();
  });

  test("atomically claims one concurrent webhook delivery", async () => {
    const claimedDeliveries = new Set<string>();
    const insert = vi.fn(() => ({
      values: vi.fn((input: ClaimWebhookDeliveryInput) => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => {
            const key = `${input.provider}:${input.deliveryId}`;
            if (claimedDeliveries.has(key)) return [];
            claimedDeliveries.add(key);
            return [{ id: "delivery-row" }];
          }),
        })),
      })),
    }));
    // The payload replay lookup (SEC-025) finds no earlier delivery.
    const select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }));
    mocks.createDb.mockReturnValue({ insert, select });
    const repository = new WebhookDeliveriesRepository({});
    const delivery: ClaimWebhookDeliveryInput = {
      provider: "github",
      deliveryId: "delivery-1",
      eventName: "pull_request",
      action: "opened",
      repositoryExternalId: "42",
      payloadHash: "payload-hash",
      normalizedEvent: {
        outcome: "irrelevant",
        reason: "unsupported_event",
      },
    };

    const outcomes = await Promise.all([
      repository.claimDelivery(delivery),
      repository.claimDelivery(delivery),
    ]);

    expect(outcomes.sort()).toEqual(["claimed", "duplicate"]);
  });

  test("reads the narrow normalized event from durable ingress", async () => {
    const normalizedEvent = {
      outcome: "irrelevant" as const,
      reason: "unsupported_event" as const,
    };
    mocks.createDb.mockReturnValue({
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ normalizedEvent }],
          }),
        }),
      })),
    });

    await expect(
      new WebhookDeliveriesRepository({}).getNormalizedEvent({
        provider: "github",
        deliveryId: "delivery-1",
      }),
    ).resolves.toEqual(normalizedEvent);
  });

  test("uses a typed domain error for unavailable enablement", () => {
    const error = new DoxabotSettingsError(
      "enablement_unavailable",
      "Unavailable.",
      "global_disabled",
    );

    expect(error.name).toBe("DoxabotSettingsError");
    expect(error.unavailableReason).toBe("global_disabled");
  });
});

describe("Doxabot production branch setting", () => {
  const update = (branchCheck: ProductionBranchCheck, state: DoxabotProjectSettingsState = privateProject) => {
    const store = createSettingsStore(state);
    const service = settingsService(store, enabledPolicy, branchCheck);
    return {
      store,
      result: service.updateForOwner({
        projectId: state.projectId,
        userId: state.ownerUserId,
        updatedByUserId: state.ownerUserId,
        changes: { productionBranch: "release/2.x" },
      }),
    };
  };

  test("saves a branch that exists and returns it as the production branch", async () => {
    const exists = vi.fn(async () => true);
    const { store, result } = update({ exists });

    await expect(result).resolves.toMatchObject({
      productionBranch: "release/2.x",
      repositoryDefaultBranch: "main",
    });
    expect(exists).toHaveBeenCalledWith(privateProject.projectId, "release/2.x");
    expect(store.update).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { productionBranch: "release/2.x" } }),
    );
  });

  test("refuses a branch that the repository does not have and saves nothing", async () => {
    const { store, result } = update({ exists: async () => false });

    await expect(result).rejects.toMatchObject({ code: "branch_not_found" });
    expect(store.update).not.toHaveBeenCalled();
  });

  test("refuses a branch while no repository is connected", async () => {
    const exists = vi.fn(async () => true);
    const { store, result } = update({ exists }, { ...privateProject, repository: { connected: false } });

    await expect(result).rejects.toMatchObject({ code: "repository_not_connected" });
    expect(exists).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  test("tells a GitHub outage apart from a missing branch", async () => {
    const { store, result } = update({
      exists: async () => {
        throw new RepositoryBranchesUnavailableError(503);
      },
    });

    await expect(result).rejects.toMatchObject({ code: "branch_check_unavailable" });
    expect(store.update).not.toHaveBeenCalled();
  });

  test("saves the allowed bot logins and returns them", async () => {
    const store = createSettingsStore(privateProject);
    const service = settingsService(store, enabledPolicy);

    await expect(service.updateForOwner({
      projectId: privateProject.projectId,
      userId: privateProject.ownerUserId,
      updatedByUserId: privateProject.ownerUserId,
      changes: { allowedBotLogins: ["dependabot[bot]", "renovate"] },
    })).resolves.toMatchObject({ allowedBotLogins: ["dependabot[bot]", "renovate"] });
    expect(store.update).toHaveBeenCalledWith(expect.objectContaining({
      changes: { allowedBotLogins: ["dependabot[bot]", "renovate"] },
    }));
  });

  test("warns when the repository became private, and a settings change clears it", async () => {
    const paused = { ...privateProject, automationWarning: "repository_privatized" as const };
    const service = settingsService(createSettingsStore(paused), enabledPolicy);

    await expect(service.getForOwner({
      projectId: paused.projectId,
      userId: paused.ownerUserId,
    })).resolves.toMatchObject({ available: true, automationWarning: "repository_privatized" });
    await expect(service.updateForOwner({
      projectId: paused.projectId,
      userId: paused.ownerUserId,
      updatedByUserId: paused.ownerUserId,
      changes: { enabled: true },
    })).resolves.toMatchObject({ enabled: true, automationWarning: null });
  });

  test.each(["repository_removed", "repository_deleted", "installation_suspended", "installation_deleted"] as const)(
    "a repository with %s is unavailable, says why, and cannot be enabled",
    async (connectionIssue) => {
      const state = {
        ...privateProject,
        repository: { ...privateProject.repository, connectionIssue },
        automationWarning: connectionIssue,
      } as DoxabotProjectSettingsState;
      const store = createSettingsStore(state);
      const service = settingsService(store, enabledPolicy);

      await expect(service.getForOwner({ projectId: state.projectId, userId: state.ownerUserId }))
        .resolves.toMatchObject({
          available: false,
          unavailableReason: "repository_not_connected",
          automationWarning: connectionIssue,
        });
      await expect(service.updateForOwner({
        projectId: state.projectId,
        userId: state.ownerUserId,
        updatedByUserId: state.ownerUserId,
        changes: { enabled: true },
      })).rejects.toEqual(expect.objectContaining({ code: "enablement_unavailable" }));
    },
  );

  test("enables a public repository while the rollout flag is on", async () => {
    const store = createSettingsStore({
      ...privateProject,
      repository: {
        connected: true,
        visibility: "public",
        defaultBranch: "main",
        productionBranch: "main",
        connectionIssue: null,
      },
    });
    const service = settingsService(store, { ...enabledPolicy, publicRepositoriesEnabled: true });

    await expect(service.updateForOwner({
      projectId: privateProject.projectId,
      userId: privateProject.ownerUserId,
      updatedByUserId: privateProject.ownerUserId,
      changes: { enabled: true },
    })).resolves.toMatchObject({ available: true, enabled: true, repositoryVisibility: "public" });
  });
});

describe("Doxabot merge trigger default (Decision 7)", () => {
  test("merge runs are manual until the owner turns them on", async () => {
    const { DEFAULT_MERGE_SETTINGS } = await vi.importActual<typeof import("../../src/repositories/doxabot-settings")>(
      "../../src/repositories/doxabot-settings",
    );
    const { schema } = await vi.importActual<typeof import("@doxahq/db")>("@doxahq/db");
    expect(DEFAULT_MERGE_SETTINGS.mergeTrigger).toBe("manual");
    expect(schema.doxabotAutomationSettings.mergeTrigger.default).toBe("manual");
  });
});
