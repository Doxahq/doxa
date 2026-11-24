import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  bigint,
  date,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const generationJobStatus = pgEnum("generation_job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  // Billing spec 10.6: AI credits or the run's credit cap stopped the run.
  "stopped_credits",
]);

export const docsVersionStatus = pgEnum("docs_version_status", [
  "staged",
  "published",
  "failed",
]);

export const docsDomainKind = pgEnum("docs_domain_kind", [
  "doxa_subdomain",
  "custom_domain",
]);

export const docsDomainStatus = pgEnum("docs_domain_status", [
  "active",
  "disabled",
]);

export const docsDomainVerificationStatus = pgEnum(
  "docs_domain_verification_status",
  ["pending", "verified", "failed"],
);

export const docsDomainRoutingStatus = pgEnum("docs_domain_routing_status", [
  "pending",
  "healthy",
  "failed",
]);

export const docsPrerenderTaskStatus = pgEnum("docs_prerender_task_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "obsolete",
]);

export const docsPrerenderTaskReason = pgEnum("docs_prerender_task_reason", [
  "generation",
  "promotion",
  "restore",
  "editor_publication",
  "starter_publication",
  "hostname_activation",
  "repair",
  "reconciliation",
]);

export const storageGcStatus = pgEnum("storage_gc_status", [
  "pending",
  "running",
  "collected",
  "retained",
  "failed",
]);

export const generationControlStatus = pgEnum("generation_control_status", [
  "enabled",
  "paused",
]);

export const agentActivityOutcome = pgEnum("agent_activity_outcome", [
  "succeeded",
  "failed",
  "approval_required",
  "denied",
  "rate_limited",
]);

export const agentClaimStatus = pgEnum("agent_claim_status", [
  "pending",
  "approved",
  "denied",
  "locked",
  "redeemed",
]);

export const agentApprovalRequestStatus = pgEnum(
  "agent_approval_request_status",
  [
    "pending",
    "executing",
    "completed",
    "failed",
    "rejected",
    "cancelled",
    "expired",
    "stale",
  ],
);

export const agentActionPolicyScope = pgEnum("agent_action_policy_scope", [
  "project",
  "user",
]);

export const agentApprovalMode = pgEnum("agent_approval_mode", [
  "allow",
  "require_approval",
  "deny",
]);

/** v2 spec §5: a member's role in a team. The role maps to capabilities in code. */
export const teamRole = pgEnum("team_role", [
  "owner",
  "admin",
  "editor",
  "viewer",
]);

export const sourceControlProvider = pgEnum("source_control_provider", [
  "github",
]);

export const webhookDeliveryStatus = pgEnum("webhook_delivery_status", [
  "claimed",
  "processed",
  "ignored",
  "enqueue_failed",
  "failed",
]);

export const changeProposalState = pgEnum("change_proposal_state", [
  "open",
  "closed",
  "merged",
]);

export const previewChannelLifecycleState = pgEnum(
  "preview_channel_lifecycle_state",
  ["active", "closed", "expired"],
);

export const generationJobTrigger = pgEnum("generation_job_trigger", [
  "manual",
  "doxabot",
  // A production run that Doxabot starts after pull requests merge.
  "merge",
]);

/**
 * What a merge into the default branch starts. `manual` only lists the
 * merged pull requests; `batched` runs once merges stop for the quiet time;
 * `every_merge` runs after each merge.
 */
export const doxabotMergeTrigger = pgEnum("doxabot_merge_trigger", [
  "manual",
  "batched",
  "every_merge",
]);

export const generationPublicationMode = pgEnum("generation_publication_mode", [
  "production",
  "preview",
]);

export const docsVersionChannel = pgEnum("docs_version_channel", [
  "production",
  "preview",
]);

export const docsPreviewVisibility = pgEnum("docs_preview_visibility", [
  "private",
  "public",
]);

export const docsBranchKind = pgEnum("docs_branch_kind", ["named", "hidden"]);
/**
 * Why a branch exists. A user branch is ordinary editor work. A generation
 * review holds the output of a production generation until a person
 * publishes it. A generation backup keeps the hand-written site that the
 * first reviewed generation replaced.
 */
export const docsBranchPurpose = pgEnum("docs_branch_purpose", [
  "user",
  "generation_review",
  "generation_backup",
]);
export const docsBranchChangeKind = pgEnum("docs_branch_change_kind", [
  "upsert",
  "delete",
]);
export const docsPublicationKind = pgEnum("docs_publication_kind", [
  "import",
  "generation",
  "starter",
  "editor",
  "promotion",
  "restore",
]);
export const docsPreviewChannelKind = pgEnum("docs_preview_channel_kind", [
  "source_change",
  "branch",
]);
export const generationReviewStatus = pgEnum("generation_review_status", [
  "open",
  "published",
  "discarded",
]);
export const generationReviewPageChange = pgEnum(
  "generation_review_page_change",
  ["added", "modified", "removed"],
);
/**
 * Who writes a page in the next generation. An owned page was written or
 * kept by a person, so a generation never rewrites it. A released page was
 * handed back to the generation, which rewrites it on its next run.
 */
export const docsPageOwnershipState = pgEnum("docs_page_ownership_state", [
  "owned",
  "released",
]);
export const generationReviewPageDecision = pgEnum(
  "generation_review_page_decision",
  ["pending", "accepted", "rejected"],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    permissions: jsonb("permissions").$type<Record<string, string>>(),
    /**
     * `active`, or what GitHub reported: `suspended` or `deleted` (the app
     * was uninstalled). Doxabot and generations need an active installation.
     */
    status: text("status")
      .$type<"active" | "suspended" | "deleted">()
      .notNull()
      .default("active"),
    /** When the status last changed. Null while it never changed. */
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    /**
     * When the owner last refreshed the repository list from GitHub. The
     * refresh has a cooldown, so a click spends the owner's GitHub budget at
     * most once a minute. Null while it never ran.
     */
    repositoriesRefreshedAt: timestamp("repositories_refreshed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("github_installations_installation_id_idx").on(
      table.installationId,
    ),
    index("github_installations_user_id_idx").on(table.userId),
    check(
      "github_installations_status",
      sql`${table.status} IN ('active', 'suspended', 'deleted')`,
    ),
  ],
);

/**
 * The GitHub user who installed the app, from the signed `installation`
 * `created` webhook (its `sender`). Keyed by the GitHub installation ID,
 * because the webhook can arrive before Doxa has an installation row. Only
 * this GitHub user can claim an organization installation (Decision 6).
 */
export const githubInstallationInstallers = pgTable(
  "github_installation_installers",
  {
    installationId: text("installation_id").primaryKey(),
    installerGithubUserId: text("installer_github_user_id").notNull(),
    installerLogin: text("installer_login").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const githubRepositories = pgTable(
  "github_repositories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    githubRepoId: text("github_repo_id").notNull(),
    fullName: text("full_name").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    isPrivate: boolean("is_private").notNull().default(false),
    /**
     * Set when GitHub reports that the app lost the repository. The row and
     * the project stay, so the site stays live; Doxabot and generations stop.
     * Null while the repository is connected.
     */
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    /** `removed` (from the installation) or `deleted` (on GitHub). */
    disconnectedReason: text("disconnected_reason").$type<
      "removed" | "deleted"
    >(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("github_repositories_github_repo_id_idx").on(
      table.githubRepoId,
    ),
    index("github_repositories_installation_id_idx").on(table.installationId),
    check(
      "github_repositories_disconnected_reason",
      sql`(${table.disconnectedAt} IS NULL AND ${table.disconnectedReason} IS NULL) OR (${table.disconnectedAt} IS NOT NULL AND ${table.disconnectedReason} IN ('removed', 'deleted'))`,
    ),
  ],
);

/**
 * A team shares projects with its members. There is no owner column: a team
 * is owned by its members with the `owner` role, and at least one must stay.
 */
export const teams = pgTable("teams", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: teamRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId] }),
    index("team_members_user_id_idx").on(table.userId),
  ],
);

/**
 * A copy link that adds one member. Only the SHA-256 hash of the random
 * token is stored. A link works once (`used_at`) and until `expires_at`.
 */
export const teamInvites = pgTable(
  "team_invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    role: teamRole("role").notNull(),
    /** Set when the invite link was sent by email. Lowercase. */
    invitedEmail: text("invited_email"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByUserId: text("used_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("team_invites_token_hash_idx").on(table.tokenHash),
    index("team_invites_team_id_idx").on(table.teamId),
    index("team_invites_team_emailed_created_idx")
      .on(table.teamId, table.createdAt)
      .where(sql`${table.invitedEmail} IS NOT NULL`),
    check(
      "team_invites_used_together",
      sql`${table.usedByUserId} IS NULL OR ${table.usedAt} IS NOT NULL`,
    ),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    githubRepositoryId: uuid("github_repository_id").references(
      () => githubRepositories.id,
      {
        onDelete: "set null",
      },
    ),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // The branch that production generations read and that merges go into.
    // Null follows the repository's default branch on GitHub.
    productionBranch: text("production_branch"),
    // The default of the erase checkbox when a person approves an agent publish.
    eraseBranchAfterPublish: boolean("erase_branch_after_publish")
      .notNull()
      .default(true),
    // When true, a member cannot approve a request that their own agent made.
    requireOtherDecider: boolean("require_other_decider")
      .notNull()
      .default(false),
    // Null for a personal project (v1 owner policy). A team with projects
    // cannot be deleted, so the reference restricts the delete.
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("projects_slug_idx").on(table.slug),
    index("projects_user_id_idx").on(table.userId),
    index("projects_team_id_idx").on(table.teamId),
  ],
);

export const doxabotAutomationSettings = pgTable(
  "doxabot_automation_settings",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    // Merge runs stay off until the owner turns them on (Decision 7).
    mergeTrigger: doxabotMergeTrigger("merge_trigger")
      .notNull()
      .default("manual"),
    batchQuietMinutes: integer("batch_quiet_minutes").notNull().default(30),
    /**
     * GitHub logins of bot accounts whose pull requests get previews. Every
     * other bot is skipped.
     */
    allowedBotLogins: text("allowed_bot_logins")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * Why Doxabot turned itself off: `repository_privatized`. A settings
     * change by the owner clears it. Null otherwise.
     */
    pausedReason: text("paused_reason").$type<"repository_privatized">(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("doxabot_automation_settings_updated_by_user_id_idx").on(
      table.updatedByUserId,
    ),
    check(
      "doxabot_automation_settings_batch_quiet_minutes",
      sql`${table.batchQuietMinutes} IN (15, 30, 60, 360)`,
    ),
  ],
);

/**
 * Doxabot instructions of a project, one row per saved version. Rows are
 * never updated: a save or a restore adds a row with the next version, so the
 * history stays complete. `body` and `screening` hold the
 * `doxabotInstructionsSchema` and `doxabotInstructionScreeningSchema`
 * contracts; the repository parses them on every write and read.
 */
export const projectInstructionVersions = pgTable(
  "project_instruction_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    body: jsonb("body").notNull(),
    screening: jsonb("screening").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_instruction_versions_project_version_idx").on(
      table.projectId,
      table.version,
    ),
    index("project_instruction_versions_created_by_user_id_idx").on(
      table.createdByUserId,
    ),
    check(
      "project_instruction_versions_version_positive",
      sql`${table.version} > 0`,
    ),
  ],
);

export const scmWebhookDeliveries = pgTable(
  "scm_webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: sourceControlProvider("provider").notNull(),
    deliveryId: text("delivery_id").notNull(),
    eventName: text("event_name").notNull(),
    action: text("action"),
    repositoryExternalId: text("repository_external_id"),
    payloadHash: text("payload_hash").notNull(),
    normalizedEvent: jsonb("normalized_event").notNull(),
    generationJobId: uuid("generation_job_id").references(
      () => generationJobs.id,
      { onDelete: "set null" },
    ),
    queuePublishedAt: timestamp("queue_published_at", {
      withTimezone: true,
    }),
    status: webhookDeliveryStatus("status").notNull().default("claimed"),
    ignoreReason: text("ignore_reason"),
    errorCode: text("error_code"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("scm_webhook_deliveries_provider_delivery_idx").on(
      table.provider,
      table.deliveryId,
    ),
    index("scm_webhook_deliveries_repository_external_id_idx").on(
      table.repositoryExternalId,
    ),
    index("scm_webhook_deliveries_status_idx").on(table.status),
    // The cron cleanup deletes old ignored and failed rows by age.
    index("scm_webhook_deliveries_status_created_at_idx").on(
      table.status,
      table.createdAt,
    ),
    index("scm_webhook_deliveries_generation_job_id_idx").on(
      table.generationJobId,
    ),
  ],
);

export const scmChangeProposals = pgTable(
  "scm_change_proposals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: sourceControlProvider("provider").notNull(),
    repositoryExternalId: text("repository_external_id").notNull(),
    installationExternalId: text("installation_external_id").notNull(),
    externalId: text("external_id").notNull(),
    displayNumber: integer("display_number").notNull(),
    draft: boolean("draft").notNull().default(false),
    state: changeProposalState("state").notNull().default("open"),
    defaultBranch: text("default_branch").notNull(),
    baseRef: text("base_ref").notNull(),
    baseRevision: text("base_revision").notNull(),
    headRevision: text("head_revision").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", {
      withTimezone: true,
    }).notNull(),
    lastSourceTreeHash: text("last_source_tree_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("scm_change_proposals_project_provider_external_idx").on(
      table.projectId,
      table.provider,
      table.externalId,
    ),
    index("scm_change_proposals_repository_external_id_idx").on(
      table.repositoryExternalId,
    ),
    index("scm_change_proposals_project_id_idx").on(table.projectId),
  ],
);

export const docsSites = pgTable(
  "docs_sites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    publishedVersionId: uuid("published_version_id"),
    previewVisibility: docsPreviewVisibility("preview_visibility")
      .notNull()
      .default("public"),
    /**
     * The search provider that serves the live site. It changes only after the
     * index worker finishes, so a site never points to an index that does not
     * exist yet. The site setting and the plan decide the provider.
     */
    searchProvider: text("search_provider").notNull().default("minisearch"),
    /**
     * The remote index that serves searches. It can belong to the previous
     * version while the live version's index builds. Null with browser search.
     */
    searchIndexKey: text("search_index_key"),
    /**
     * When a sweep first saw that index behind the live version. It limits how
     * long the site serves old results, across publishes and retries. Null while
     * the site serves its live version's result.
     */
    searchIndexStaleSince: timestamp("search_index_stale_since", {
      withTimezone: true,
    }),
    /**
     * Set when an operator clears the generation cache. Versions created at or
     * before this instant are ineligible as generation baselines, so the next
     * run analyzes from scratch. Published docs keep serving throughout.
     */
    generationBaselineResetAt: timestamp("generation_baseline_reset_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("docs_sites_project_id_idx").on(table.projectId),
    uniqueIndex("docs_sites_slug_idx").on(table.slug),
  ],
);

export const docsVersions = pgTable(
  "docs_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => docsSites.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    status: docsVersionStatus("status").notNull().default("staged"),
    channel: docsVersionChannel("channel").notNull().default("production"),
    artifactPrefix: text("artifact_prefix").notNull(),
    manifestPath: text("manifest_path").notNull(),
    sourceRevision: text("source_revision"),
    sourceTreeHash: text("source_tree_hash"),
    baselineVersionId: uuid("baseline_version_id").references(
      (): AnyPgColumn => docsVersions.id,
      { onDelete: "set null" },
    ),
    generatorFingerprint: text("generator_fingerprint"),
    generationStatePrefix: text("generation_state_prefix").notNull(),
    /**
     * When a newer push moved the pull request preview channel off this
     * version. The retention policy keeps a replaced preview promotable for
     * a few days after this time. Null for a version that no channel left.
     */
    previewReplacedAt: timestamp("preview_replaced_at", {
      withTimezone: true,
    }),
    /**
     * When the `docs_retired_version` collector decided to delete the folder
     * of this version. The row stays in the history, but the version can no
     * longer be restored or promoted.
     */
    artifactsCollectedAt: timestamp("artifacts_collected_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // Each channel has its own number sequence per site. A preview never takes
  // a number from the published sequence, so published numbers have no gaps.
  (table) => [
    uniqueIndex("docs_versions_site_production_number_idx")
      .on(table.siteId, table.versionNumber)
      .where(sql`${table.channel} = 'production'`),
    uniqueIndex("docs_versions_site_preview_number_idx")
      .on(table.siteId, table.versionNumber)
      .where(sql`${table.channel} = 'preview'`),
    index("docs_versions_site_id_idx").on(table.siteId),
    check("docs_versions_number_positive", sql`${table.versionNumber} > 0`),
  ],
);

export const docsBranches = pgTable(
  "docs_branches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => docsSites.id, { onDelete: "cascade" }),
    kind: docsBranchKind("kind").notNull(),
    purpose: docsBranchPurpose("purpose").notNull().default("user"),
    name: text("name"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    baseVersionId: uuid("base_version_id")
      .notNull()
      .references(() => docsVersions.id),
    createdFromBranchId: uuid("created_from_branch_id").references(
      (): AnyPgColumn => docsBranches.id,
      { onDelete: "set null" },
    ),
    revision: integer("revision").notNull().default(0),
    previewRevision: integer("preview_revision"),
    // The OAuth client that created the branch through MCP, and the member
    // it acted for (in a team project, owner_user_id is the project owner).
    // Null for a branch from the dashboard. Only that client, acting for that
    // member, may delete the branch. The user ID becomes null when the member
    // is deleted; the branch then has no agent that may delete it.
    // The name is a snapshot: the MCP Worker cannot read the client registry.
    createdByClientId: text("created_by_client_id"),
    createdByClientName: text("created_by_client_name"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("docs_branches_site_name_idx")
      .on(table.siteId, table.name)
      .where(sql`${table.kind} = 'named'`),
    uniqueIndex("docs_branches_site_hidden_owner_idx")
      .on(table.siteId, table.ownerUserId)
      .where(sql`${table.kind} = 'hidden'`),
    index("docs_branches_site_id_idx").on(table.siteId),
    check(
      "docs_branches_name_matches_kind",
      sql`(${table.kind} = 'named' AND ${table.name} IS NOT NULL)
       OR (${table.kind} = 'hidden' AND ${table.name} IS NULL)`,
    ),
    check(
      "docs_branches_creator_client_complete",
      sql`(${table.createdByClientId} IS NULL) = (${table.createdByClientName} IS NULL)`,
    ),
    // Not "all three or none": the user ID alone goes null on member delete.
    check(
      "docs_branches_creator_user_has_client",
      sql`${table.createdByUserId} IS NULL OR ${table.createdByClientId} IS NOT NULL`,
    ),
  ],
);

export const docsBranchChanges = pgTable(
  "docs_branch_changes",
  {
    branchId: uuid("branch_id")
      .notNull()
      .references(() => docsBranches.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    kind: docsBranchChangeKind("kind").notNull(),
    content: text("content"),
    contentSha256: text("content_sha256"),
    byteSize: integer("byte_size").notNull().default(0),
    updatedByUserId: text("updated_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.branchId, table.path] }),
    check(
      "docs_branch_changes_content_matches_kind",
      sql`(${table.kind} = 'upsert' AND ${table.content} IS NOT NULL AND ${table.contentSha256} IS NOT NULL)
       OR (${table.kind} = 'delete' AND ${table.content} IS NULL AND ${table.contentSha256} IS NULL)`,
    ),
    check(
      "docs_branch_changes_byte_size_nonnegative",
      sql`${table.byteSize} >= 0`,
    ),
  ],
);

/**
 * A pull request that merged into the default branch after the last
 * production generation started. A production run that succeeds removes the
 * merges it covers. `attemptedAt` marks merges that the scheduler already
 * tried to generate, so it starts again only for a newer merge.
 */
export const generationPendingMerges = pgTable(
  "generation_pending_merges",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    changeExternalId: text("change_external_id").notNull(),
    changeNumber: integer("change_number").notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.changeExternalId] }),
    index("generation_pending_merges_due_idx").on(
      table.attemptedAt,
      table.mergedAt,
    ),
  ],
);

/**
 * One production generation waiting for a person. The review branch holds
 * the working changes; this row links it to the run that produced them and
 * to the staged version whose generation state the published site inherits.
 */
export const generationReviews = pgTable(
  "generation_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => docsSites.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => docsBranches.id, {
      onDelete: "set null",
    }),
    jobId: uuid("job_id")
      .notNull()
      .references((): AnyPgColumn => generationJobs.id, {
        onDelete: "cascade",
      }),
    generatedVersionId: uuid("generated_version_id")
      .notNull()
      .references(() => docsVersions.id),
    status: generationReviewStatus("status").notNull().default("open"),
    /** Set when the review replaces a site that no generation wrote. */
    createsBackup: boolean("creates_backup").notNull().default(false),
    backupBranchId: uuid("backup_branch_id").references(
      () => docsBranches.id,
      { onDelete: "set null" },
    ),
    publishedVersionId: uuid("published_version_id").references(
      () => docsVersions.id,
    ),
    /** Pages a person owns whose source changed in the run, as review flags. */
    ownedPageFlags: jsonb("owned_page_flags").notNull().default([]),
    closedByUserId: text("closed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("generation_reviews_site_open_idx")
      .on(table.siteId)
      .where(sql`${table.status} = 'open'`),
    uniqueIndex("generation_reviews_job_idx").on(table.jobId),
    index("generation_reviews_site_created_idx").on(
      table.siteId,
      table.createdAt,
    ),
    check(
      "generation_reviews_closed_matches_status",
      sql`(${table.status} = 'open') = (${table.closedAt} IS NULL)`,
    ),
    check(
      "generation_reviews_published_has_version",
      sql`(${table.status} = 'published') = (${table.publishedVersionId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Pages that a person owns or handed back, by href. A page without a row
 * belongs to the generation.
 */
export const docsPageOwnership = pgTable(
  "docs_page_ownership",
  {
    siteId: uuid("site_id")
      .notNull()
      .references(() => docsSites.id, { onDelete: "cascade" }),
    href: text("href").notNull(),
    state: docsPageOwnershipState("state").notNull(),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.siteId, table.href] })],
);

/** The decision for one page that a generation review would change. */
export const generationReviewPages = pgTable(
  "generation_review_pages",
  {
    reviewId: uuid("review_id")
      .notNull()
      .references(() => generationReviews.id, { onDelete: "cascade" }),
    href: text("href").notNull(),
    title: text("title").notNull(),
    change: generationReviewPageChange("change").notNull(),
    decision: generationReviewPageDecision("decision").notNull(),
    reasons: jsonb("reasons").notNull().default([]),
    /**
     * Where the page is on the review branch after a person renamed or
     * moved it there. Null while the page keeps its generated href.
     */
    branchHref: text("branch_href"),
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.reviewId, table.href] })],
);

export const docsPublications = pgTable(
  "docs_publications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => docsSites.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => docsVersions.id),
    previousVersionId: uuid("previous_version_id").references(
      () => docsVersions.id,
    ),
    kind: docsPublicationKind("kind").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    branchName: text("branch_name"),
    summary: jsonb("summary").notNull().default({}),
    agentClientId: text("agent_client_id"),
    agentClientName: text("agent_client_name"),
    approvalRequestId: uuid("approval_request_id").references(
      (): AnyPgColumn => agentApprovalRequests.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("docs_publications_site_created_idx").on(
      table.siteId,
      table.createdAt,
    ),
  ],
);

export const docsPreviewChannels = pgTable(
  "docs_preview_channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => docsSites.id, { onDelete: "cascade" }),
    kind: docsPreviewChannelKind("kind").notNull().default("source_change"),
    branchId: uuid("branch_id").references(() => docsBranches.id, {
      onDelete: "cascade",
    }),
    provider: sourceControlProvider("provider"),
    changeExternalId: text("change_external_id"),
    hostname: text("hostname").notNull(),
    currentVersionId: uuid("current_version_id").references(
      () => docsVersions.id,
      { onDelete: "set null" },
    ),
    lifecycleState: previewChannelLifecycleState("lifecycle_state")
      .notNull()
      .default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("docs_preview_channels_project_site_change_idx").on(
      table.projectId,
      table.siteId,
      table.provider,
      table.changeExternalId,
    ),
    uniqueIndex("docs_preview_channels_hostname_idx").on(table.hostname),
    uniqueIndex("docs_preview_channels_branch_id_idx").on(table.branchId),
    index("docs_preview_channels_project_id_idx").on(table.projectId),
    check(
      "docs_preview_channels_kind_fields",
      sql`(${table.kind} = 'source_change' AND ${table.provider} IS NOT NULL AND ${table.changeExternalId} IS NOT NULL AND ${table.branchId} IS NULL)
       OR (${table.kind} = 'branch' AND ${table.branchId} IS NOT NULL AND ${table.provider} IS NULL AND ${table.changeExternalId} IS NULL)`,
    ),
  ],
);

export const docsDomains = pgTable(
  "docs_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => docsSites.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    kind: docsDomainKind("kind").notNull(),
    status: docsDomainStatus("status").notNull().default("active"),
    verificationStatus: docsDomainVerificationStatus("verification_status")
      .notNull()
      .default("pending"),
    provider: text("provider"),
    providerHostnameId: text("provider_hostname_id"),
    providerStatus: text("provider_status"),
    providerSslStatus: text("provider_ssl_status"),
    ownershipVerificationType: text("ownership_verification_type"),
    ownershipVerificationName: text("ownership_verification_name"),
    ownershipVerificationValue: text("ownership_verification_value"),
    ownershipVerificationHttpUrl: text("ownership_verification_http_url"),
    ownershipVerificationHttpBody: text("ownership_verification_http_body"),
    sslValidationRecords: jsonb("ssl_validation_records").$type<
      Array<{
        status: string | null;
        txtName: string | null;
        txtValue: string | null;
        httpUrl: string | null;
        httpBody: string | null;
      }>
    >(),
    verificationError: text("verification_error"),
    routingStatus: docsDomainRoutingStatus("routing_status")
      .notNull()
      .default("pending"),
    routingHttpStatus: integer("routing_http_status"),
    routingError: text("routing_error"),
    routingCheckedAt: timestamp("routing_checked_at", { withTimezone: true }),
    /** The last status check of a custom domain, by a person, an agent, or the cron. Null: never checked. */
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("docs_domains_hostname_idx").on(table.hostname),
    index("docs_domains_status_check_idx")
      .on(table.verificationStatus, table.lastCheckedAt)
      .where(sql`${table.kind} = 'custom_domain' AND ${table.providerHostnameId} IS NOT NULL`),
    index("docs_domains_project_id_idx").on(table.projectId),
    index("docs_domains_site_id_idx").on(table.siteId),
  ],
);

/**
 * One search index task per published version. The row is also the record of
 * what the version costs: its documents and its indexed bytes.
 */
export const docsSearchIndexes = pgTable(
  "docs_search_indexes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => docsSites.id, { onDelete: "cascade" }),
    versionId: uuid("version_id").notNull(),
    /** pending, running, ready, skipped, failed, superseded or retired. */
    status: text("status").notNull().default("pending"),
    /** The provider of this version. Set before a remote write starts. */
    provider: text("provider"),
    /** The remote index of this build. Set before a remote write starts. */
    indexKey: text("index_key"),
    documentCount: integer("document_count"),
    indexedBytes: bigint("indexed_bytes", { mode: "number" }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimToken: text("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("docs_search_indexes_site_version_idx").on(
      table.siteId,
      table.versionId,
    ),
    index("docs_search_indexes_due_idx").on(table.status, table.nextAttemptAt),
  ],
);

/**
 * Search usage of a site per day, rolled up from the gateway's data points. It
 * has no foreign key, because the cost of a deleted site stays readable. No
 * column holds search text.
 */
export const docsSearchUsageDaily = pgTable(
  "docs_search_usage_daily",
  {
    day: date("day").notNull(),
    siteId: uuid("site_id").notNull(),
    provider: text("provider").notNull(),
    outcome: text("outcome").notNull(),
    events: bigint("events", { mode: "number" }).notNull().default(0),
    responseBytes: bigint("response_bytes", { mode: "number" })
      .notNull()
      .default(0),
    elapsedMsTotal: bigint("elapsed_ms_total", { mode: "number" })
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.day, table.siteId, table.provider, table.outcome],
    }),
    index("docs_search_usage_daily_site_idx").on(table.siteId, table.day),
  ],
);

export const docsPrerenderTasks = pgTable(
  "docs_prerender_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => docsSites.id, { onDelete: "cascade" }),
    publishedVersionId: uuid("published_version_id")
      .notNull()
      .references(() => docsVersions.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    trustedRequestOrigin: text("trusted_request_origin").notNull(),
    artifactPrefix: text("artifact_prefix").notNull(),
    sourceManifestPath: text("source_manifest_path").notNull(),
    sourceArtifactVersion: text("source_artifact_version").notNull(),
    artifactIdentity: text("artifact_identity").notNull(),
    rendererReleaseId: text("renderer_release_id").notNull(),
    renderContextId: text("render_context_id").notNull(),
    renderId: text("render_id").notNull(),
    reason: docsPrerenderTaskReason("reason").notNull(),
    status: docsPrerenderTaskStatus("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimToken: text("claim_token"),
    leaseDeadline: timestamp("lease_deadline", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    completedRoutes: integer("completed_routes").notNull().default(0),
    totalRoutes: integer("total_routes").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("docs_prerender_tasks_logical_identity_idx").on(
      table.siteId,
      table.artifactIdentity,
      table.rendererReleaseId,
      table.renderContextId,
    ),
    index("docs_prerender_tasks_due_idx").on(table.status, table.nextAttemptAt),
    index("docs_prerender_tasks_site_status_idx").on(
      table.siteId,
      table.status,
    ),
    index("docs_prerender_tasks_render_id_idx").on(table.renderId),
    index("docs_prerender_tasks_lease_deadline_idx").on(table.leaseDeadline),
  ],
);

/**
 * Generic work list for deleting derived storage objects.
 *
 * One row is one resource that stopped serving production. The `target` names
 * the registered collector. The collector owns the mapping from `resource` to
 * object keys, so no row stores a raw storage key.
 */
export const storageGcEntries = pgTable(
  "storage_gc_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    target: text("target").notNull(),
    resourceKey: text("resource_key").notNull(),
    resource: jsonb("resource").notNull(),
    reason: text("reason").notNull(),
    status: storageGcStatus("status").notNull().default("pending"),
    eligibleAt: timestamp("eligible_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimToken: text("claim_token"),
    leaseDeadline: timestamp("lease_deadline", { withTimezone: true }),
    deletedObjects: integer("deleted_objects").notNull().default(0),
    lastError: text("last_error"),
    retainedReason: text("retained_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("storage_gc_entries_resource_idx").on(
      table.target,
      table.resourceKey,
    ),
    index("storage_gc_entries_due_idx").on(
      table.status,
      table.eligibleAt,
      table.nextAttemptAt,
    ),
    index("storage_gc_entries_lease_deadline_idx").on(table.leaseDeadline),
  ],
);

export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    status: generationJobStatus("status").notNull().default("queued"),
    trigger: generationJobTrigger("trigger").notNull().default("manual"),
    publicationMode: generationPublicationMode("publication_mode")
      .notNull()
      .default("production"),
    docsVersionId: uuid("docs_version_id").references(() => docsVersions.id, {
      onDelete: "set null",
    }),
    sourceProvider: sourceControlProvider("source_provider"),
    sourceInstallationExternalId: text("source_installation_external_id"),
    sourceAuthorExternalId: text("source_author_external_id"),
    sourceAuthorHandle: text("source_author_handle"),
    sourceAuthorAvatarUrl: text("source_author_avatar_url"),
    changeProposalId: uuid("change_proposal_id").references(
      () => scmChangeProposals.id,
      { onDelete: "set null" },
    ),
    changeExternalId: text("change_external_id"),
    baselineRevision: text("baseline_revision"),
    targetRevision: text("target_revision"),
    sourceTreeHash: text("source_tree_hash"),
    baselineVersionId: uuid("baseline_version_id").references(
      () => docsVersions.id,
      { onDelete: "set null" },
    ),
    /**
     * The hand-written version that a seeded run reads: its structure anchors
     * the plan and each page's text guides its writer. Null for other runs.
     */
    seedVersionId: uuid("seed_version_id").references(
      () => docsVersions.id,
      { onDelete: "set null" },
    ),
    agentModel: text("agent_model"),
    plannerModel: text("planner_model"),
    writerModel: text("writer_model"),
    planningFingerprint: text("planning_fingerprint"),
    writingFingerprint: text("writing_fingerprint"),
    generationProfile: text("generation_profile"),
    generatorFingerprint: text("generator_fingerprint"),
    idempotencyKey: text("idempotency_key").notNull(),
    concurrencyKey: text("concurrency_key").notNull(),
    externalReviewRunId: text("external_review_run_id"),
    supersededByJobId: uuid("superseded_by_job_id").references(
      (): AnyPgColumn => generationJobs.id,
      { onDelete: "set null" },
    ),
    errorMessage: text("error_message"),
    eventSequence: integer("event_sequence").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("generation_jobs_project_id_idx").on(table.projectId),
    uniqueIndex("generation_jobs_idempotency_key_idx").on(table.idempotencyKey),
    uniqueIndex("generation_jobs_active_concurrency_idx")
      .on(table.concurrencyKey)
      .where(sql`${table.status} in ('queued', 'running')`),
    index("generation_jobs_requested_by_user_id_idx").on(
      table.requestedByUserId,
    ),
    index("generation_jobs_source_author_idx").on(
      table.sourceProvider,
      table.sourceAuthorExternalId,
    ),
    index("generation_jobs_change_proposal_id_idx").on(table.changeProposalId),
    index("generation_jobs_baseline_version_id_idx").on(
      table.baselineVersionId,
    ),
    index("generation_jobs_superseded_by_job_id_idx").on(
      table.supersededByJobId,
    ),
  ],
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    source: text("source").notNull().default("api"),
    type: text("type").notNull(),
    message: text("message").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("job_events_job_id_idx").on(table.jobId),
    uniqueIndex("job_events_job_sequence_idx").on(table.jobId, table.sequence),
  ],
);

export const generationUsageRecords = pgTable(
  "generation_usage_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callId: uuid("call_id").notNull(),
    /**
     * Spend attribution. It survives the deletion of the generation, so cost
     * analysis never depends on a mutable operational row. The generation is
     * the only source of this value, and the API resolves it at insert time.
     */
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * Null after the generation is deleted. Read spend through `projectId`,
     * never through this column.
     */
    jobId: uuid("job_id").references(() => generationJobs.id, {
      onDelete: "set null",
    }),
    stageExecutionId: uuid("stage_execution_id").notNull(),
    stage: text("stage").notNull(),
    operation: text("operation").notNull(),
    modelRole: text("model_role").notNull(),
    model: text("model").notNull(),
    pageId: text("page_id"),
    pageTitle: text("page_title"),
    pageRetry: integer("page_retry"),
    attempt: integer("attempt"),
    iteration: integer("iteration").notNull(),
    providerGenerationId: text("provider_generation_id"),
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    cachedTokens: integer("cached_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    costUsd: numeric("cost_usd", { precision: 24, scale: 12 }),
    promptCostUsd: numeric("prompt_cost_usd", { precision: 24, scale: 12 }),
    completionCostUsd: numeric("completion_cost_usd", {
      precision: 24,
      scale: 12,
    }),
    upstreamCostUsd: numeric("upstream_cost_usd", {
      precision: 24,
      scale: 12,
    }),
    durationMs: integer("duration_ms"),
    finishReason: text("finish_reason"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    /**
     * Unused. Usage rows are kept until billing decides their retention, so
     * nothing deletes them and new rows leave this null. Migration 0038 made
     * the column nullable and cleared it.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("generation_usage_records_call_id_idx").on(table.callId),
    index("generation_usage_records_job_id_idx").on(table.jobId),
    index("generation_usage_records_project_id_idx").on(table.projectId),
  ],
);

export const generationRepairDiagnostics = pgTable(
  "generation_repair_diagnostics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    diagnosticId: uuid("diagnostic_id").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    stageExecutionId: uuid("stage_execution_id").notNull(),
    pageId: text("page_id").notNull(),
    pageTitle: text("page_title").notNull(),
    pageRetry: integer("page_retry").notNull(),
    writerAttempt: integer("writer_attempt").notNull(),
    attempt: integer("attempt").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    model: text("model").notNull(),
    rule: text("rule").notNull(),
    message: text("message").notNull(),
    line: integer("line"),
    column: integer("column"),
    snippet: text("snippet"),
    draftKey: text("draft_key").notNull(),
    draftSha256: text("draft_sha256").notNull(),
    draftTruncated: boolean("draft_truncated").notNull(),
    repairKind: text("repair_kind").notNull(),
    repairSucceeded: boolean("repair_succeeded").notNull(),
    rejectionReason: text("rejection_reason"),
    validationIssueCodes: jsonb("validation_issue_codes")
      .$type<string[]>()
      .notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("generation_repair_diagnostics_diagnostic_id_idx").on(
      table.diagnosticId,
    ),
    index("generation_repair_diagnostics_job_id_idx").on(table.jobId),
    index("generation_repair_diagnostics_expires_at_idx").on(table.expiresAt),
  ],
);

export const platformGenerationControls = pgTable(
  "platform_generation_controls",
  {
    id: text("id").primaryKey(),
    status: generationControlStatus("status").notNull().default("enabled"),
    reason: text("reason"),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

/**
 * A gated agent action that waits for a human decision. `action_kind` is
 * text, so adding or removing an action needs no migration. A row leaves
 * `pending` or `executing` once and never changes again.
 */
export const agentApprovalRequests = pgTable(
  "agent_approval_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Null only for project.create, which has no project yet.
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    actionKind: text("action_kind").notNull(),
    targetKey: text("target_key").notNull(),
    status: agentApprovalRequestStatus("status").notNull(),
    payloadVersion: integer("payload_version").notNull(),
    payload: jsonb("payload").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    summary: text("summary"),
    result: jsonb("result"),
    error: jsonb("error"),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    requestedByClientId: text("requested_by_client_id").notNull(),
    requestedByClientName: text("requested_by_client_name").notNull(),
    grantRef: text("grant_ref").notNull(),
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    decisionNote: text("decision_note"),
    policySource: text("policy_source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("agent_approval_requests_project_status_created_idx").on(
      table.projectId,
      table.status,
      table.createdAt,
    ),
    index("agent_approval_requests_requester_created_idx").on(
      table.requestedByUserId,
      table.createdAt,
    ),
    uniqueIndex("agent_approval_requests_pending_target_idx")
      .on(table.projectId, table.actionKind, table.targetKey)
      .where(sql`${table.status} = 'pending'`),
    check(
      "agent_approval_requests_summary_length",
      sql`char_length(${table.summary}) <= 500`,
    ),
    check(
      "agent_approval_requests_decision_note_length",
      sql`char_length(${table.decisionNote}) <= 500`,
    ),
  ],
);

/**
 * Append-only record of agent writes, expensive calls, and approval
 * decisions. Reads go to the Worker logs instead. Holds a hash of the input,
 * never the content.
 */
export const agentActivity = pgTable(
  "agent_activity",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    grantRef: text("grant_ref").notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    tool: text("tool").notNull(),
    actionKind: text("action_kind"),
    approvalRequestId: uuid("approval_request_id").references(
      () => agentApprovalRequests.id,
      { onDelete: "set null" },
    ),
    outcome: agentActivityOutcome("outcome").notNull(),
    errorCode: text("error_code"),
    policySource: text("policy_source"),
    durationMs: integer("duration_ms").notNull(),
    inputSha256: text("input_sha256"),
    // Small structured facts about the event, such as the old and the new
    // mode of an approval setting. Never page content.
    details: jsonb("details"),
  },
  (table) => [
    index("agent_activity_project_occurred_idx").on(
      table.projectId,
      table.occurredAt,
    ),
    index("agent_activity_user_occurred_idx").on(
      table.userId,
      table.occurredAt,
    ),
  ],
);

/**
 * What agents do on a project, for the live panel in the Content tab. This
 * is separate from `agent_activity`: it also has read tools and can hold a
 * diff, so rows last 24 hours. `seq` orders the rows of one project; a writer
 * takes it under a project lock, so that a reader never skips a row.
 */
export const agentLiveEvents = pgTable(
  "agent_live_events",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    branchId: uuid("branch_id").references(() => docsBranches.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    grantRef: text("grant_ref").notNull(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    tool: text("tool").notNull(),
    kind: text("kind").notNull(),
    pageHref: text("page_href"),
    pageTitle: text("page_title"),
    detail: text("detail"),
    note: text("note"),
    linesAdded: integer("lines_added"),
    linesRemoved: integer("lines_removed"),
    branchRevision: integer("branch_revision"),
    diff: text("diff"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.seq] }),
    index("agent_live_events_occurred_idx").on(table.occurredAt),
  ],
);

/**
 * The approval mode a project admin or a user picked for one agent action.
 * One row for each scope and action; no row means "not set". A project row
 * wins over a user row. `action_kind` is text, as in the request table.
 * The scope is split into two typed columns so a deleted project or user
 * takes its rows with it.
 */
export const agentActionPolicies = pgTable(
  "agent_action_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeKind: agentActionPolicyScope("scope_kind").notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    actionKind: text("action_kind").notNull(),
    mode: agentApprovalMode("mode").notNull(),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // NULLs are distinct, so each index only constrains its own scope.
    uniqueIndex("agent_action_policies_project_action_idx").on(
      table.projectId,
      table.actionKind,
    ),
    uniqueIndex("agent_action_policies_user_action_idx").on(
      table.userId,
      table.actionKind,
    ),
    check(
      "agent_action_policies_scope_target",
      sql`(${table.scopeKind} = 'project' AND ${table.projectId} IS NOT NULL AND ${table.userId} IS NULL) OR (${table.scopeKind} = 'user' AND ${table.userId} IS NOT NULL AND ${table.projectId} IS NULL)`,
    ),
  ],
);

export const projectRelations = relations(projects, ({ one, many }) => ({
  user: one(user, { fields: [projects.userId], references: [user.id] }),
  team: one(teams, { fields: [projects.teamId], references: [teams.id] }),
  repository: one(githubRepositories, {
    fields: [projects.githubRepositoryId],
    references: [githubRepositories.id],
  }),
  site: one(docsSites),
  domains: many(docsDomains),
  jobs: many(generationJobs),
  doxabotSettings: one(doxabotAutomationSettings),
  changeProposals: many(scmChangeProposals),
  previewChannels: many(docsPreviewChannels),
}));

export const docsSiteRelations = relations(docsSites, ({ one, many }) => ({
  project: one(projects, {
    fields: [docsSites.projectId],
    references: [projects.id],
  }),
  versions: many(docsVersions),
  domains: many(docsDomains),
  prerenderTasks: many(docsPrerenderTasks),
  previewChannels: many(docsPreviewChannels),
}));

export const docsDomainRelations = relations(docsDomains, ({ one }) => ({
  project: one(projects, {
    fields: [docsDomains.projectId],
    references: [projects.id],
  }),
  site: one(docsSites, {
    fields: [docsDomains.siteId],
    references: [docsSites.id],
  }),
}));

export const docsPrerenderTaskRelations = relations(
  docsPrerenderTasks,
  ({ one }) => ({
    site: one(docsSites, {
      fields: [docsPrerenderTasks.siteId],
      references: [docsSites.id],
    }),
    publishedVersion: one(docsVersions, {
      fields: [docsPrerenderTasks.publishedVersionId],
      references: [docsVersions.id],
    }),
  }),
);

/**
 * A request from an agent to connect to a person's account (auth.md claim
 * flow). Every secret is stored only as a hash. The cron removes old rows.
 */
export const agentClaims = pgTable(
  "agent_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    claimTokenHash: text("claim_token_hash").notNull().unique(),
    attemptTokenHash: text("attempt_token_hash").notNull().unique(),
    userCodeHash: text("user_code_hash").notNull(),
    clientName: text("client_name").notNull(),
    tokenName: text("token_name").notNull(),
    loginHint: text("login_hint"),
    clientIpKey: text("client_ip_key"),
    requestedScopes: text("requested_scopes").array().notNull(),
    status: agentClaimStatus("status").notNull().default("pending"),
    codeAttempts: integer("code_attempts").notNull().default(0),
    approvedUserId: text("approved_user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    approvedScopes: text("approved_scopes").array(),
    approvedProjectScope: jsonb("approved_project_scope"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("agent_claims_expires_idx").on(table.expiresAt),
    index("agent_claims_login_hint_created_idx").on(
      table.loginHint,
      table.createdAt,
    ),
    index("agent_claims_client_ip_created_idx").on(
      table.clientIpKey,
      table.createdAt,
    ),
  ],
);

/** A long-life credential for an agent. Only the SHA-256 hash is stored. */
export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    tokenName: text("token_name").notNull(),
    clientName: text("client_name").notNull(),
    scopes: text("scopes").array().notNull(),
    projectScope: jsonb("project_scope").notNull(),
    grantRef: uuid("grant_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_tokens_user_created_idx").on(table.userId, table.createdAt),
    index("agent_tokens_expires_idx").on(table.expiresAt),
  ],
);
