import type {
  DoxabotSettingsDto,
  DoxabotUnavailableReason,
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
  public_repository_disabled: {
    statusLabel: "Private only",
    statusTone: "muted",
    title: "Public repositories are not supported yet",
    description:
      "Doxabot is currently limited to private repositories. Public repository support can be enabled in a future rollout.",
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
            "Doxabot will prepare documentation previews for eligible pull requests targeting the default branch.",
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
