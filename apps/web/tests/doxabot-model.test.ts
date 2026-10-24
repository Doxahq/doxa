import {
  doxabotSettingsSchema,
  type DoxabotSettingsDto,
} from "@doxahq/contracts"
import { describe, expect, test } from "vitest"

import { getDoxabotViewModel } from "../src/lib/dashboard/doxabot-model"

function settings(
  overrides: Partial<DoxabotSettingsDto> = {},
): DoxabotSettingsDto {
  return doxabotSettingsSchema.parse({
    enabled: false,
    mergeTrigger: "batched",
    batchQuietMinutes: 30,
    repositoryVisibility: "private",
    available: true,
    unavailableReason: null,
    updatedAt: null,
    ...overrides,
  })
}

function viewModel(
  overrides: Partial<Parameters<typeof getDoxabotViewModel>[0]> = {},
) {
  return getDoxabotViewModel({
    settings: settings(),
    isLoading: false,
    isSaving: false,
    error: null,
    ...overrides,
  })
}

describe("Doxabot dashboard view model", () => {
  test("covers loading state", () => {
    expect(viewModel({ settings: null, isLoading: true })).toMatchObject({
      kind: "loading",
      actionDisabled: true,
    })
  })

  test("covers enabled state", () => {
    expect(viewModel({ settings: settings({ enabled: true }) })).toMatchObject({
      kind: "enabled",
      statusLabel: "Enabled",
      actionLabel: "Disable Doxabot",
      nextEnabled: false,
      actionDisabled: false,
    })
  })

  test("covers eligible disabled state", () => {
    expect(viewModel()).toMatchObject({
      kind: "disabled",
      statusLabel: "Disabled",
      actionLabel: "Enable Doxabot",
      nextEnabled: true,
      actionDisabled: false,
    })
  })

  test.each([
    ["global_disabled", "Doxabot is temporarily unavailable"],
    ["initial_generation_required", "Publish the documentation first"],
    ["public_repository_disabled", "Public repositories are not supported yet"],
    ["repository_not_connected", "Connect a repository first"],
  ] as const)("covers %s", (reason, title) => {
    const unavailableSettings: DoxabotSettingsDto = {
      enabled: false,
      mergeTrigger: "batched",
      batchQuietMinutes: 30,
      repositoryVisibility:
        reason === "repository_not_connected" ? null : "private",
      available: false,
      unavailableReason: reason,
      updatedAt: null,
    }

    expect(viewModel({ settings: unavailableSettings })).toMatchObject({
      kind: reason,
      title,
      actionLabel: "Enable Doxabot",
      actionDisabled: true,
    })
  })

  test("keeps disablement available when a saved setting becomes unavailable", () => {
    const unavailableSettings: DoxabotSettingsDto = {
      enabled: true,
      mergeTrigger: "batched",
      batchQuietMinutes: 30,
      repositoryVisibility: "private",
      available: false,
      unavailableReason: "global_disabled",
      updatedAt: null,
    }

    expect(viewModel({
      settings: unavailableSettings,
      isSaving: true,
    })).toMatchObject({
      kind: "global_disabled",
      actionLabel: "Disabling…",
      nextEnabled: false,
      actionDisabled: true,
    })
  })

  test("covers query errors", () => {
    expect(viewModel({
      settings: null,
      error: "Request failed",
    })).toMatchObject({
      kind: "error",
      description: "Request failed",
      actionDisabled: true,
    })
  })
})
