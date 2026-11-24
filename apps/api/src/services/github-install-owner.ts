import type { GitHubInstaller } from "../repositories/github-lifecycle";

/**
 * Who may claim a GitHub installation for a Doxa account (Decision 6).
 *
 * - An installation that Doxa has already recorded keeps its owner. Only that
 *   owner can connect it again; the owner moves it with a transfer.
 * - An organization installation: only the GitHub user who installed the app
 *   (the `sender` of the signed `installation.created` webhook). Other
 *   members of the organization get access through Doxa teams.
 * - A user account installation: only the GitHub user who owns that account.
 *
 * `githubUserId` comes from the user token of this install flow, so it is the
 * GitHub account that the Doxa user controls now.
 */
export type InstallationClaimDecision =
  | { outcome: "accept" }
  /** The `installation.created` webhook did not arrive yet. */
  | { outcome: "installer_unknown" }
  | { outcome: "not_installer"; installerLogin: string }
  | { outcome: "not_account_owner" }
  | { outcome: "owned_by_other_user" };

export function decideInstallationClaim(input: {
  userId: string;
  /** The Doxa owner of the recorded installation, or null when there is none. */
  currentOwnerUserId: string | null;
  accountType: string;
  /** The GitHub ID of the installation's account. */
  accountId: string | null;
  githubUserId: string;
  installer: GitHubInstaller | null;
}): InstallationClaimDecision {
  if (input.currentOwnerUserId !== null) {
    return input.currentOwnerUserId === input.userId
      ? { outcome: "accept" }
      : { outcome: "owned_by_other_user" };
  }
  if (input.accountType === "Organization") {
    if (!input.installer) return { outcome: "installer_unknown" };
    return input.installer.githubUserId === input.githubUserId
      ? { outcome: "accept" }
      : { outcome: "not_installer", installerLogin: input.installer.login };
  }
  // A user account: the installing user is the account owner.
  return input.accountId !== null && input.accountId === input.githubUserId
    ? { outcome: "accept" }
    : { outcome: "not_account_owner" };
}
