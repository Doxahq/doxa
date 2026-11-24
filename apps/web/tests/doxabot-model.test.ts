import {
  doxabotSettingsSchema,
  type DoxabotSettingsDto,
} from "@doxahq/contracts"
import { describe, expect, test } from "vitest"

import {
  addAllowedBotLogin,
  getDoxabotAutomationNotice,
  getDoxabotViewModel,
  removeAllowedBotLogin,
} from "../src/lib/dashboard/doxabot-model"

function settings(
  overrides: Partial<DoxabotSettingsDto> = {},
): DoxabotSettingsDto {
  return doxabotSettingsSchema.parse({
    enabled: false,
    mergeTrigger: "batched",
    batchQuietMinutes: 30,
    repositoryVisibility: "private",
    productionBranch: "main",
    repositoryDefaultBranch: "main",
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
    ["public_repository_disabled", "Not available yet"],
    ["repository_not_connected", "Connect a repository first"],
  ] as const)("covers %s", (reason, title) => {
    const unavailableSettings: DoxabotSettingsDto = {
      enabled: false,
      mergeTrigger: "batched",
      batchQuietMinutes: 30,
      repositoryVisibility:
        reason === "repository_not_connected" ? null : "private",
      productionBranch: reason === "repository_not_connected" ? null : "main",
      repositoryDefaultBranch: reason === "repository_not_connected" ? null : "main",
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
      productionBranch: "main",
      repositoryDefaultBranch: "main",
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

describe("Doxabot automation warning", () => {
  test("shows nothing without a warning or on an older API", () => {
    expect(getDoxabotAutomationNotice(null)).toBeNull()
    expect(getDoxabotAutomationNotice(settings())).toBeNull()
    expect(getDoxabotAutomationNotice(settings({ automationWarning: null }))).toBeNull()
  })

  test.each([
    ["repository_privatized", "The repository is now private", "turned off pull request previews"],
    ["repository_removed", "The repository was removed from the GitHub App", "Add the repository"],
    ["repository_deleted", "The repository was deleted on GitHub", "Connect a repository"],
    ["installation_suspended", "The GitHub App is suspended", "Unsuspend the app"],
    ["installation_deleted", "The GitHub App was uninstalled", "Install the app again"],
  ] as const)("says what happened for %s and that the site stays live", (warning, title, fix) => {
    const notice = getDoxabotAutomationNotice(settings({ automationWarning: warning }))
    expect(notice).toMatchObject({ warning, title })
    expect(notice?.description).toContain("Your site stays live")
    expect(notice?.description).toContain(fix)
  })

  test("points the previews card to the banner when the repository link broke", () => {
    const lost = settings({
      available: false,
      unavailableReason: "repository_not_connected",
      automationWarning: "installation_suspended",
    })
    expect(viewModel({ settings: lost })).toMatchObject({
      kind: "repository_not_connected",
      statusLabel: "Stopped",
      title: "Doxabot lost access to the repository",
      actionDisabled: true,
    })
  })

  test("keeps the usual previews card text for a private repository warning", () => {
    expect(viewModel({ settings: settings({ automationWarning: "repository_privatized" }) })).toMatchObject({
      kind: "disabled",
    })
  })
})

describe("Allowed bot logins", () => {
  test("adds a valid login and keeps the order", () => {
    expect(addAllowedBotLogin(["renovate[bot]"], " dependabot ")).toEqual({
      ok: true,
      logins: ["renovate[bot]", "dependabot"],
    })
  })

  test("refuses a duplicate with or without the [bot] suffix", () => {
    expect(addAllowedBotLogin(["dependabot[bot]"], "Dependabot")).toMatchObject({ ok: false })
    expect(addAllowedBotLogin(["dependabot"], "dependabot[bot]")).toMatchObject({ ok: false })
  })

  test("refuses a name that is not a GitHub login", () => {
    expect(addAllowedBotLogin([], "")).toMatchObject({ ok: false })
    expect(addAllowedBotLogin([], "not a login")).toMatchObject({ ok: false })
    expect(addAllowedBotLogin([], "-dash")).toMatchObject({ ok: false })
  })

  test("refuses a full list", () => {
    const full = Array.from({ length: 20 }, (_, index) => `bot${index}`)
    expect(addAllowedBotLogin(full, "another")).toEqual({
      ok: false,
      error: "You can allow up to 20 bots.",
    })
  })

  test("removes a login without case and without [bot]", () => {
    expect(removeAllowedBotLogin(["dependabot[bot]", "renovate"], "Dependabot")).toEqual(["renovate"])
  })
})
