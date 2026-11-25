import { REPOSITORY_REQUIRED_MESSAGE } from "@doxahq/contracts";
import type { RepositoryConnectionIssue } from "../repositories/github-lifecycle";

// Type imports only besides contracts: the MCP actions load this module, and
// they must not load the generation dispatchers.

const REPOSITORY_ISSUE_MESSAGES: Record<RepositoryConnectionIssue, string> = {
  repository_removed:
    "The repository was removed from the doxabot GitHub App. Add it to the app again to run a generation. The site stays live.",
  repository_deleted:
    "The repository was deleted on GitHub. Connect another repository to run a generation. The site stays live.",
  installation_suspended:
    "The doxabot GitHub App is suspended on GitHub. Unsuspend it to run a generation. The site stays live.",
  installation_deleted:
    "The doxabot GitHub App was uninstalled. Install it again to run a generation. The site stays live.",
};

/** The text of a `repository_required` refusal: why the repository cannot be used. */
export function repositoryRequiredMessage(reason?: RepositoryConnectionIssue): string {
  return reason ? REPOSITORY_ISSUE_MESSAGES[reason] : REPOSITORY_REQUIRED_MESSAGE;
}
