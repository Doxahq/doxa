import type {
  InstallationLifecycleAction,
  NormalizedRepositoryLifecycleEvent,
  NormalizedSourceControlEvent,
  RepositoryLifecycleAction,
  RepositoryLifecycleChange,
  SourceControlEventParseResult,
  SourceControlIrrelevantReason,
  SourceRepository,
} from "@doxahq/contracts";
import { z } from "zod";
import {
  DOXA_DOCUMENTATION_PREVIEW_CHECK,
  RETRY_PREVIEW_ACTION_ID,
} from "./preview-check-identity";

const githubIdSchema = z.number().int().positive();
const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** Names are optional: only lifecycle events use them, and GitHub always sends them. */
const githubRepositoryNamesSchema = {
  name: z.string().min(1).optional(),
  full_name: z.string().min(1).optional(),
  owner: z.object({ login: z.string().min(1) }).optional(),
};

const githubRepositorySchema = z.object({
  id: githubIdSchema,
  private: z.boolean(),
  default_branch: z.string().min(1),
  ...githubRepositoryNamesSchema,
});

/**
 * The short repository object of `installation` and
 * `installation_repositories` events: no default branch and no owner.
 */
const githubRepositoryReferenceSchema = z.object({
  id: githubIdSchema,
  private: z.boolean(),
  default_branch: z.string().min(1).optional(),
  ...githubRepositoryNamesSchema,
});

const githubInstallationSchema = z.object({
  id: githubIdSchema,
});

const githubUserSchema = z.object({
  id: githubIdSchema,
  login: z.string().min(1),
  avatar_url: z.url().nullable(),
  /** `User`, `Bot` or `Organization`. */
  type: z.string().optional(),
});

const pullRequestActionSchema = z.enum([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "closed",
  // Only an edit that moves the base counts; see parsePullRequest.
  "edited",
]);

const pullRequestEnvelopeSchema = z.object({
  action: z.string(),
});

const pullRequestPayloadSchema = z.object({
  action: pullRequestActionSchema,
  number: z.number().int().positive(),
  installation: githubInstallationSchema,
  repository: githubRepositorySchema.extend({
    /** The repository size in KB. A bad value is dropped, not refused. */
    size: z.number().int().nonnegative().optional().catch(undefined),
  }),
  /** On "edited": what changed. `base` is set when the target branch moved. */
  changes: z.object({ base: z.unknown().optional() }).passthrough().optional(),
  pull_request: z.object({
    id: githubIdSchema,
    user: githubUserSchema.nullable(),
    updated_at: z.string().datetime(),
    draft: z.boolean(),
    merged: z.boolean(),
    base: z.object({
      ref: z.string().min(1),
      sha: gitObjectIdSchema,
    }),
    head: z.object({
      sha: gitObjectIdSchema,
      // Null when the fork was deleted.
      repo: z.object({ id: githubIdSchema }).nullable().optional(),
    }),
  }),
});

const pushPayloadSchema = z.object({
  ref: z.string().min(1),
  before: gitObjectIdSchema,
  after: gitObjectIdSchema,
  installation: githubInstallationSchema,
  repository: githubRepositorySchema,
});

const repositoryActionSchema = z.enum([
  "archived",
  "created",
  "deleted",
  "edited",
  "privatized",
  "publicized",
  "renamed",
  "transferred",
  "unarchived",
]);

const repositoryEnvelopeSchema = z.object({
  action: z.string(),
});

const repositoryPayloadSchema = z.object({
  action: repositoryActionSchema,
  installation: githubInstallationSchema,
  repository: githubRepositorySchema,
});

const installationRepositoriesActionSchema = z.enum(["added", "removed"]);

const installationRepositoriesEnvelopeSchema = z.object({
  action: z.string(),
});

const installationRepositoriesPayloadSchema = z.object({
  action: installationRepositoriesActionSchema,
  installation: githubInstallationSchema,
  repositories_added: z.array(githubRepositoryReferenceSchema),
  repositories_removed: z.array(githubRepositoryReferenceSchema),
});

const installationActionSchema = z.enum([
  "created",
  "deleted",
  "new_permissions_accepted",
  "suspend",
  "unsuspend",
]);

const installationEnvelopeSchema = z.object({
  action: z.string(),
});

const installationPayloadSchema = z.object({
  action: installationActionSchema,
  installation: githubInstallationSchema,
  /** The GitHub user who acted. On `created`, the user who installed the app. */
  sender: z.object({ id: githubIdSchema, login: z.string().min(1) }).optional(),
});

/**
 * A person asked for a check run again. GitHub sends these two actions to
 * the app that created the check, without a subscription.
 */
const checkRunActionSchema = z.enum(["rerequested", "requested_action"]);

const checkRunEnvelopeSchema = z.object({
  action: z.string(),
});

const checkRunPayloadSchema = z.object({
  action: checkRunActionSchema,
  installation: githubInstallationSchema,
  repository: githubRepositorySchema,
  /** The person who pressed the button. */
  sender: z.object({ id: githubIdSchema, login: z.string().min(1) }),
  check_run: z.object({
    id: githubIdSchema,
    name: z.string(),
    external_id: z.string().nullable().optional(),
  }),
  requested_action: z.object({ identifier: z.string() }).optional(),
});

const repositoryActionMap: Record<
  z.infer<typeof repositoryActionSchema>,
  RepositoryLifecycleAction
> = {
  archived: "updated",
  created: "connected",
  deleted: "disconnected",
  edited: "updated",
  privatized: "updated",
  publicized: "updated",
  renamed: "updated",
  transferred: "updated",
  unarchived: "updated",
};

const installationActionMap: Record<
  z.infer<typeof installationActionSchema>,
  InstallationLifecycleAction
> = {
  created: "created",
  deleted: "deleted",
  new_permissions_accepted: "permissions_accepted",
  suspend: "suspended",
  unsuspend: "unsuspended",
};

export interface ParseGitHubEventInput {
  eventName: string;
  deliveryId: string;
  payload: unknown;
}

export function parseGitHubEvent(
  input: ParseGitHubEventInput,
): SourceControlEventParseResult {
  if (!input.deliveryId.trim()) return malformed();

  switch (input.eventName) {
    case "pull_request":
      return parsePullRequest(input);
    case "push":
      return parsePush(input);
    case "repository":
      return parseRepository(input);
    case "installation_repositories":
      return parseInstallationRepositories(input);
    case "installation":
      return parseInstallation(input);
    case "check_run":
      return parseCheckRun(input);
    default:
      return irrelevant("unsupported_event");
  }
}

function parsePullRequest(
  input: ParseGitHubEventInput,
): SourceControlEventParseResult {
  const envelope = pullRequestEnvelopeSchema.safeParse(input.payload);
  if (!envelope.success) return malformed();
  if (!pullRequestActionSchema.safeParse(envelope.data.action).success) {
    return irrelevant("unsupported_action");
  }

  const parsed = pullRequestPayloadSchema.safeParse(input.payload);
  if (!parsed.success) return malformed();
  const payload = parsed.data;
  // A title or body edit changes nothing a preview reads. A base change moves
  // the pull request onto or off the production branch.
  if (payload.action === "edited" && payload.changes?.base === undefined) {
    return irrelevant("unsupported_action");
  }
  // GitHub always sends head.repo; null means a deleted fork. Doxabot
  // previews no pull request from a fork, whoever opened it (Decision 3).
  // The event still goes on: a merged fork pull request feeds the merge
  // trigger, and the orchestrator stops a preview made before this rule.
  const headRepo = payload.pull_request.head.repo;
  const fromFork = headRepo === null || (headRepo !== undefined && headRepo.id !== payload.repository.id);

  return normalized({
    kind: "change_proposal",
    deliveryId: input.deliveryId,
    action: payload.action === "edited" ? "base_changed" : payload.action,
    repository: toSourceRepository(
      payload.repository,
      payload.installation.id,
    ),
    change: {
      externalId: String(payload.pull_request.id),
      number: payload.number,
      author: payload.pull_request.user
        ? {
            externalId: String(payload.pull_request.user.id),
            handle: payload.pull_request.user.login,
            avatarUrl: payload.pull_request.user.avatar_url,
          }
        : null,
      authorIsBot: payload.pull_request.user?.type === "Bot",
      fromFork,
      ...(payload.repository.size !== undefined ? { repositorySizeKb: payload.repository.size } : {}),
      draft: payload.pull_request.draft,
      merged: payload.pull_request.merged,
      baseRef: payload.pull_request.base.ref,
      baseRevision: { commitSha: payload.pull_request.base.sha },
      headRevision: { commitSha: payload.pull_request.head.sha },
      sourceUpdatedAt: payload.pull_request.updated_at,
    },
  });
}

function parsePush(input: ParseGitHubEventInput): SourceControlEventParseResult {
  const parsed = pushPayloadSchema.safeParse(input.payload);
  if (!parsed.success) return malformed();
  const payload = parsed.data;
  const defaultBranchRef = `refs/heads/${payload.repository.default_branch}`;
  if (payload.ref !== defaultBranchRef) {
    return irrelevant("non_default_branch_push");
  }

  return normalized({
    kind: "default_branch_push",
    deliveryId: input.deliveryId,
    repository: toSourceRepository(
      payload.repository,
      payload.installation.id,
    ),
    ref: payload.ref,
    beforeRevision: { commitSha: payload.before },
    afterRevision: { commitSha: payload.after },
  });
}

function parseRepository(
  input: ParseGitHubEventInput,
): SourceControlEventParseResult {
  const envelope = repositoryEnvelopeSchema.safeParse(input.payload);
  if (!envelope.success) return malformed();
  if (!repositoryActionSchema.safeParse(envelope.data.action).success) {
    return irrelevant("unsupported_action");
  }

  const parsed = repositoryPayloadSchema.safeParse(input.payload);
  if (!parsed.success) return malformed();

  return normalized(
    toRepositoryLifecycleEvent({
      deliveryId: input.deliveryId,
      action: repositoryActionMap[parsed.data.action],
      change: parsed.data.action,
      repository: parsed.data.repository,
      installationId: parsed.data.installation.id,
    }),
  );
}

function parseInstallationRepositories(
  input: ParseGitHubEventInput,
): SourceControlEventParseResult {
  const envelope = installationRepositoriesEnvelopeSchema.safeParse(
    input.payload,
  );
  if (!envelope.success) return malformed();
  if (
    !installationRepositoriesActionSchema.safeParse(envelope.data.action)
      .success
  ) {
    return irrelevant("unsupported_action");
  }

  const parsed = installationRepositoriesPayloadSchema.safeParse(
    input.payload,
  );
  if (!parsed.success) return malformed();
  const repositories =
    parsed.data.action === "added"
      ? parsed.data.repositories_added
      : parsed.data.repositories_removed;
  if (repositories.length === 0) {
    return irrelevant("no_repository_changes");
  }

  const action = parsed.data.action === "added" ? "connected" : "disconnected";
  return normalized(
    ...repositories.map((repository) =>
      toRepositoryLifecycleEvent({
        deliveryId: input.deliveryId,
        action,
        change: parsed.data.action,
        repository,
        installationId: parsed.data.installation.id,
      }),
    ),
  );
}

function parseInstallation(
  input: ParseGitHubEventInput,
): SourceControlEventParseResult {
  const envelope = installationEnvelopeSchema.safeParse(input.payload);
  if (!envelope.success) return malformed();
  if (!installationActionSchema.safeParse(envelope.data.action).success) {
    return irrelevant("unsupported_action");
  }

  const parsed = installationPayloadSchema.safeParse(input.payload);
  if (!parsed.success) return malformed();

  // One event for the whole installation: a suspend or an uninstall applies
  // to every repository, also when GitHub does not list them.
  const { sender } = parsed.data;
  return normalized({
    kind: "installation_lifecycle",
    deliveryId: input.deliveryId,
    provider: "github",
    installationExternalId: String(parsed.data.installation.id),
    action: installationActionMap[parsed.data.action],
    // Only the sender of `created` is kept: that user installed the app, and
    // only that user can claim an organization installation (Decision 6).
    ...(parsed.data.action === "created" && sender
      ? { sender: { externalId: String(sender.id), login: sender.login } }
      : {}),
  });
}

/**
 * "Re-run" or "Retry preview" on a Doxa preview check. The check's external
 * ID is the generation job; the orchestrator checks it against the record.
 */
function parseCheckRun(input: ParseGitHubEventInput): SourceControlEventParseResult {
  const envelope = checkRunEnvelopeSchema.safeParse(input.payload);
  if (!envelope.success) return malformed();
  if (!checkRunActionSchema.safeParse(envelope.data.action).success) {
    return irrelevant("unsupported_action");
  }

  const parsed = checkRunPayloadSchema.safeParse(input.payload);
  if (!parsed.success) return malformed();
  const payload = parsed.data;
  const jobId = z.uuid().safeParse(payload.check_run.external_id);
  if (payload.check_run.name !== DOXA_DOCUMENTATION_PREVIEW_CHECK || !jobId.success) {
    return irrelevant("foreign_check");
  }
  if (
    payload.action === "requested_action" &&
    payload.requested_action?.identifier !== RETRY_PREVIEW_ACTION_ID
  ) {
    return irrelevant("unsupported_action");
  }

  return normalized({
    kind: "review_run_retry",
    deliveryId: input.deliveryId,
    repository: toSourceRepository(payload.repository, payload.installation.id),
    externalRunId: String(payload.check_run.id),
    jobId: jobId.data,
    trigger: payload.action === "rerequested" ? "rerun" : "retry_action",
    requestedBy: {
      externalId: String(payload.sender.id),
      login: payload.sender.login,
    },
  });
}

function toRepositoryLifecycleEvent(input: {
  deliveryId: string;
  action: RepositoryLifecycleAction;
  change: RepositoryLifecycleChange;
  repository: z.infer<typeof githubRepositoryReferenceSchema>;
  installationId: number;
}): NormalizedRepositoryLifecycleEvent {
  const {
    default_branch: defaultBranch,
    full_name: fullName,
    name,
    owner,
  } = input.repository;
  return {
    kind: "repository_lifecycle",
    deliveryId: input.deliveryId,
    action: input.action,
    change: input.change,
    repository: {
      provider: "github",
      externalId: String(input.repository.id),
      installationExternalId: String(input.installationId),
      visibility: input.repository.private ? "private" : "public",
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(fullName ? { fullName } : {}),
      ...(owner ? { owner: owner.login } : {}),
      ...(name ? { name } : {}),
    },
  };
}

function toSourceRepository(
  repository: z.infer<typeof githubRepositorySchema>,
  installationId: number,
): SourceRepository {
  return {
    provider: "github",
    externalId: String(repository.id),
    installationExternalId: String(installationId),
    visibility: repository.private ? "private" : "public",
    defaultBranch: repository.default_branch,
  };
}

function normalized(
  ...events: NormalizedSourceControlEvent[]
): SourceControlEventParseResult {
  return { outcome: "normalized", events };
}

function irrelevant(
  reason: SourceControlIrrelevantReason,
): SourceControlEventParseResult {
  return { outcome: "irrelevant", reason };
}

function malformed(): SourceControlEventParseResult {
  return { outcome: "malformed", reason: "invalid_payload" };
}
