import {
  DOXABOT_ALLOWED_BOT_LOGINS_LIMIT,
  doxabotBotLoginSchema,
  normalizeBotLogin,
  type DoxabotAutomationWarning,
  type DoxabotSettingsDto,
  type DoxabotUnavailableReason,
} from "@doxahq/contracts"

export type DoxabotViewKind =
  | "loading"
  | "error"
  | "enabled"
  | "disabled"
  | DoxabotUnavailableReason

export type DoxabotStatusTone =
  | "success"
  | "muted"
  | "warning"
  | "destructive"

export interface DoxabotViewModel {
  kind: DoxabotViewKind
  statusLabel: string
  statusTone: DoxabotStatusTone
  title: string
  description: string
  actionLabel: string
  nextEnabled: boolean
  actionDisabled: boolean
}

export interface DoxabotViewModelInput {
  settings: DoxabotSettingsDto | null
  isLoading: boolean
  isSaving: boolean
  error: string | null
}

const unavailableContent: Record<
  DoxabotUnavailableReason,
  Pick<DoxabotViewModel, "statusLabel" | "statusTone" | "title" | "description">
> = {
  global_disabled: {
    statusLabel: "Unavailable",
    statusTone: "warning",
    title: "Doxabot is temporarily unavailable",
    description:
      "Automatic documentation updates are paused across Doxa. Your saved setting will be preserved.",
  },
  initial_generation_required: {
    statusLabel: "Setup required",
    statusTone: "warning",
    title: "Publish the documentation first",
    description:
      "Run and publish the first documentation generation before enabling pull request previews.",
  },
  // The API still sends this reason while public repositories are switched
  // off in production.
  public_repository_disabled: {
    statusLabel: "Unavailable",
    statusTone: "muted",
    title: "Not available yet",
    description: "Doxabot is not available for public repositories yet.",
  },
  repository_not_connected: {
    statusLabel: "Repository required",
    statusTone: "warning",
    title: "Connect a repository first",
    description:
      "This project needs a connected GitHub repository before Doxabot can watch pull requests.",
  },
}

export function getDoxabotViewModel(
  input: DoxabotViewModelInput,
): DoxabotViewModel {
  if (input.isLoading) {
    return {
      kind: "loading",
      statusLabel: "Loading",
      statusTone: "muted",
      title: "Loading Doxabot settings",
      description: "Checking repository eligibility and saved settings.",
      actionLabel: "Enable Doxabot",
      nextEnabled: true,
      actionDisabled: true,
    }
  }

  if (input.error || !input.settings) {
    return {
      kind: "error",
      statusLabel: "Error",
      statusTone: "destructive",
      title: "Doxabot settings could not be loaded",
      description: input.error ?? "Try refreshing the page.",
      actionLabel: "Enable Doxabot",
      nextEnabled: true,
      actionDisabled: true,
    }
  }

  const { settings } = input
  const action = getAction(settings, input.isSaving)

  if (settings.available) {
    return settings.enabled
      ? {
          kind: "enabled",
          statusLabel: "Enabled",
          statusTone: "success",
          title: "Pull request previews are enabled",
          description:
            "Doxabot will prepare documentation previews for eligible pull requests targeting the production branch.",
          ...action,
        }
      : {
          kind: "disabled",
          statusLabel: "Disabled",
          statusTone: "muted",
          title: "Enable automatic documentation previews",
          description:
            "Doxabot analyzes eligible pull request changes and prepares a review-only documentation preview.",
          ...action,
        }
  }

  if (
    settings.unavailableReason === "repository_not_connected"
    && isRepositoryConnectionWarning(settings.automationWarning)
  ) {
    return {
      kind: settings.unavailableReason,
      statusLabel: "Stopped",
      statusTone: "warning",
      title: "Doxabot lost access to the repository",
      description: "The notice at the top of this page says what happened and how to fix it.",
      ...action,
    }
  }

  return {
    kind: settings.unavailableReason,
    ...unavailableContent[settings.unavailableReason],
    ...action,
  }
}

function getAction(
  settings: DoxabotSettingsDto,
  isSaving: boolean,
): Pick<
  DoxabotViewModel,
  "actionLabel" | "nextEnabled" | "actionDisabled"
> {
  return settings.enabled
    ? {
        actionLabel: isSaving ? "Disabling…" : "Disable Doxabot",
        nextEnabled: false,
        actionDisabled: isSaving,
      }
    : {
        actionLabel: isSaving ? "Enabling…" : "Enable Doxabot",
        nextEnabled: true,
        actionDisabled: isSaving || !settings.available,
      }
}

export interface DoxabotAutomationNotice {
  warning: DoxabotAutomationWarning
  title: string
  description: string
}

const SITE_STAYS_LIVE = "Your site stays live with the docs that are published now."

const automationNoticeContent: Record<
  DoxabotAutomationWarning,
  Omit<DoxabotAutomationNotice, "warning">
> = {
  repository_privatized: {
    title: "The repository is now private",
    description: `Doxabot turned off pull request previews and set merge updates to manual. ${SITE_STAYS_LIVE} Change a setting below to start updates again.`,
  },
  repository_removed: {
    title: "The repository was removed from the GitHub App",
    description: `Doxabot cannot read the repository, so updates stopped. ${SITE_STAYS_LIVE} Add the repository to the doxabot GitHub App again to start updates.`,
  },
  repository_deleted: {
    title: "The repository was deleted on GitHub",
    description: `Updates stopped because the repository is gone. ${SITE_STAYS_LIVE} Connect a repository to update the docs again.`,
  },
  installation_suspended: {
    title: "The GitHub App is suspended",
    description: `The doxabot GitHub App was suspended on GitHub, so updates stopped. ${SITE_STAYS_LIVE} Unsuspend the app in your GitHub settings to start updates.`,
  },
  installation_deleted: {
    title: "The GitHub App was uninstalled",
    description: `The doxabot GitHub App was removed from GitHub, so updates stopped. ${SITE_STAYS_LIVE} Install the app again to start updates.`,
  },
}

/** What stopped Doxabot, as text for the page banner. Null when nothing did. */
export function getDoxabotAutomationNotice(
  settings: DoxabotSettingsDto | null,
): DoxabotAutomationNotice | null {
  const warning = settings?.automationWarning ?? null
  if (!warning) return null
  return { warning, ...automationNoticeContent[warning] }
}

/**
 * True when the repository link itself is broken (not only made private). The
 * previews card then points to the banner, not to "Connect a repository".
 */
export function isRepositoryConnectionWarning(
  warning: DoxabotAutomationWarning | null | undefined,
): boolean {
  return Boolean(warning) && warning !== "repository_privatized"
}

export type AddBotLoginResult =
  | { ok: true; logins: string[] }
  | { ok: false; error: string }

/**
 * Adds a bot login to the list. It refuses a name that is not a GitHub login,
 * a name already in the list (with or without `[bot]`), and a full list.
 */
export function addAllowedBotLogin(
  logins: readonly string[],
  input: string,
): AddBotLoginResult {
  const parsed = doxabotBotLoginSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Enter a GitHub login." }
  }
  const login = parsed.data
  const key = normalizeBotLogin(login)
  if (logins.some((existing) => normalizeBotLogin(existing) === key)) {
    return { ok: false, error: `${login} is already in the list.` }
  }
  if (logins.length >= DOXABOT_ALLOWED_BOT_LOGINS_LIMIT) {
    return { ok: false, error: `You can allow up to ${DOXABOT_ALLOWED_BOT_LOGINS_LIMIT} bots.` }
  }
  return { ok: true, logins: [...logins, login] }
}

/** Removes a bot login, matched without case and without `[bot]`. */
export function removeAllowedBotLogin(
  logins: readonly string[],
  login: string,
): string[] {
  const key = normalizeBotLogin(login)
  return logins.filter((existing) => normalizeBotLogin(existing) !== key)
}
