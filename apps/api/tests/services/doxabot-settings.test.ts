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
import {
  DoxabotSettingsError,
  DoxabotSettingsService,
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
  },
  hasPublishedVersion: true,
  storedEnabled: false,
  mergeTrigger: "batched",
  batchQuietMinutes: 30,
  updatedAt: null,
};

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
    const service = new DoxabotSettingsService(store, enabledPolicy);

    await expect(service.getForOwner({
      projectId: privateProject.projectId,
      userId: privateProject.ownerUserId,
    })).resolves.toEqual({
      available: true,
      enabled: true,
      mergeTrigger: "batched",
      batchQuietMinutes: 30,
      repositoryVisibility: "private",
      unavailableReason: null,
      updatedAt: null,
    });
  });

  test("does not reveal settings to a non-owner", async () => {
    const store = createSettingsStore(privateProject);
    const service = new DoxabotSettingsService(store, enabledPolicy);

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
    const service = new DoxabotSettingsService(store, enabledPolicy);

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
      },
    });
    const service = new DoxabotSettingsService(store, enabledPolicy);

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
    const service = new DoxabotSettingsService(store, {
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
    const service = new DoxabotSettingsService(store, enabledPolicy);

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
    const service = new DoxabotSettingsService(store, {
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
  const service = new DoxabotSettingsService(store, {
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
    mocks.createDb.mockReturnValue({ insert });
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
