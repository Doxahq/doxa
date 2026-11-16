import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

async function readMigration(name) {
  return readFile(resolve(currentDirectory, "../migrations", name), "utf8");
}

/**
 * `drizzle-kit generate` writes `ADD COLUMN ... NOT NULL` with no backfill,
 * which fails on a table that holds rows. This migration is hand-written.
 * A regenerate that clobbers it must break this test, not production.
 */
test("0016 backfills project_id before it becomes required", async () => {
  const sql = await readMigration("0016_yielding_ronan.sql");

  const addColumn = sql.indexOf('ADD COLUMN "project_id" uuid');
  const backfill = sql.indexOf('SET "project_id" = j."project_id"');
  const setNotNull = sql.indexOf('ALTER COLUMN "project_id" SET NOT NULL');

  assert.ok(addColumn >= 0, "the migration must add project_id");
  assert.ok(backfill >= 0, "the migration must backfill project_id");
  assert.ok(setNotNull >= 0, "the migration must make project_id required");

  assert.ok(
    addColumn < backfill,
    "project_id must exist before the backfill runs",
  );
  assert.ok(
    backfill < setNotNull,
    "the backfill must run before project_id becomes required",
  );

  assert.ok(
    !/ADD COLUMN "project_id" uuid NOT NULL/.test(sql),
    "project_id must be added as nullable, then filled, then made required",
  );
});

test("0016 never removes a spend row", async () => {
  const sql = await readMigration("0016_yielding_ronan.sql");

  assert.ok(
    !/DELETE\s+FROM\s+"generation_usage_records"/i.test(sql),
    "this migration exists to preserve spend rows, so it must never delete one",
  );
  assert.match(
    sql,
    /RAISE EXCEPTION/,
    "an unattributed row must stop the migration for a human to resolve",
  );
});

test("0016 keeps spend rows when a generation is deleted", async () => {
  const sql = await readMigration("0016_yielding_ronan.sql");

  assert.match(
    sql,
    /ALTER COLUMN "job_id" DROP NOT NULL/,
    "job_id must be nullable so a deleted generation can clear it",
  );
  assert.match(
    sql,
    /"generation_usage_records_job_id_generation_jobs_id_fk"[\s\S]*ON DELETE set null/,
    "deleting a generation must clear job_id, never remove the spend row",
  );
});

test("0017 can run before the author-aware API deploys", async () => {
  const sql = await readMigration("0017_groovy_golden_guardian.sql");

  for (const column of [
    "source_author_external_id",
    "source_author_handle",
    "source_author_avatar_url",
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN "${column}" text`));
    assert.doesNotMatch(
      sql,
      new RegExp(`ADD COLUMN "${column}" text NOT NULL`),
      `${column} must stay nullable for old API instances and manual jobs`,
    );
  }
});

test("0018 keeps existing generation previews private", async () => {
  const sql = await readMigration("0018_charming_loki.sql");

  assert.match(
    sql,
    /ADD COLUMN "preview_visibility" "docs_preview_visibility" DEFAULT 'private' NOT NULL/,
    "existing sites must get the private preview visibility default",
  );
});

test("0019 makes every generation preview public", async () => {
  const sql = await readMigration("0019_smooth_golden_guardian.sql");

  assert.match(
    sql,
    /ALTER COLUMN "preview_visibility" SET DEFAULT 'public'/,
    "new sites must default to public previews while authentication is unavailable",
  );
  assert.match(
    sql,
    /UPDATE "docs_sites" SET "preview_visibility" = 'public'/,
    "existing sites must report the same public state that the API serves",
  );
});

test("0020 keeps existing domain delivery state honest", async () => {
  const sql = await readMigration("0020_fair_cerebro.sql");

  assert.match(
    sql,
    /ADD COLUMN "routing_status" "docs_domain_routing_status" DEFAULT 'pending' NOT NULL/,
    "existing domains must wait for a real delivery check instead of being marked healthy",
  );
  assert.doesNotMatch(
    sql,
    /UPDATE "docs_domains" SET "routing_status" = 'healthy'/,
    "the migration must not claim that untested domains are healthy",
  );
});

test("0021 preserves pending invalidations independently of sites and domains", async () => {
  const sql = await readMigration("0021_docs_cache_invalidations.sql");
  assert.match(sql, /CREATE TABLE "docs_cache_invalidations"/);
  assert.doesNotMatch(sql, /REFERENCES|ON DELETE|DROP TABLE|DELETE FROM/i);
  assert.match(sql, /"claim_token" uuid/);
  assert.match(sql, /"lease_until" timestamp with time zone/);
  assert.match(sql, /"next_attempt_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
  assert.match(sql, /CREATE INDEX "docs_cache_invalidations_pending_idx"[\s\S]*"completed_at" is null/);
});

/**
 * `drizzle-kit generate` wrote the index changes of 0025. The renumbering is
 * hand-written. A regenerate that drops it must break this test.
 */
test("0025 renumbers previews between the old and the new indexes", async () => {
  const sql = await readMigration("0025_docs_version_channel_numbers.sql");

  const dropOldIndex = sql.indexOf('DROP INDEX "docs_versions_site_version_idx"');
  const renumber = sql.indexOf('SET "version_number" = numbered."preview_number"');
  const previewIndex = sql.indexOf(
    'CREATE UNIQUE INDEX "docs_versions_site_preview_number_idx"',
  );
  const positiveCheck = sql.indexOf('"docs_versions_number_positive"');

  assert.ok(dropOldIndex >= 0, "the migration must drop the shared index");
  assert.ok(renumber >= 0, "the migration must renumber preview versions");
  assert.ok(
    dropOldIndex < renumber,
    "the shared index must go before previews reuse low numbers",
  );
  assert.ok(
    renumber < previewIndex,
    "previews must have unique numbers before their index exists",
  );
  assert.ok(
    renumber < positiveCheck,
    "negative preview numbers must be gone before the check exists",
  );
  assert.match(
    sql.slice(renumber - 200, renumber + 400),
    /WHERE "channel" = 'preview'/,
    "the renumbering must never change a production number",
  );
});

test("0027 holds one pending approval request for each target", async () => {
  const sql = await readMigration("0027_agent_approval_requests.sql");

  assert.match(
    sql,
    /CREATE UNIQUE INDEX "agent_approval_requests_pending_target_idx"[^;]*\("project_id","action_kind","target_key"\) WHERE "agent_approval_requests"\."status" = 'pending'/,
    "two pending requests for one target must be impossible",
  );
  assert.match(sql, /CHECK \(char_length\("agent_approval_requests"\."summary"\) <= 500\)/);
  assert.match(sql, /CHECK \(char_length\("agent_approval_requests"\."decision_note"\) <= 500\)/);
});

test("0027 can run before the attribution-aware API deploys", async () => {
  const sql = await readMigration("0027_agent_approval_requests.sql");

  for (const [column, type] of [
    ["agent_client_id", "text"],
    ["agent_client_name", "text"],
    ["approval_request_id", "uuid"],
  ]) {
    assert.match(sql, new RegExp(`"docs_publications" ADD COLUMN "${column}" ${type};`));
  }
  for (const table of ["agent_activity", "docs_publications"]) {
    assert.match(
      sql,
      new RegExp(
        `ALTER TABLE "${table}" ADD CONSTRAINT [^;]*FOREIGN KEY \\("approval_request_id"\\) REFERENCES "public"\\."agent_approval_requests"\\("id"\\) ON DELETE set null`,
      ),
      `deleting a request must keep the ${table} rows`,
    );
  }
});

test("0028 adds approval settings without touching existing rows", async () => {
  const sql = await readMigration("0028_agent_action_policies.sql");

  assert.match(
    sql,
    /"projects" ADD COLUMN "erase_branch_after_publish" boolean DEFAULT true NOT NULL;/,
    "existing projects must get the default, so the column needs no backfill",
  );
  assert.match(sql, /"agent_activity" ADD COLUMN "details" jsonb;/);
  assert.match(sql, /CREATE UNIQUE INDEX "agent_action_policies_project_action_idx"[^;]*\("project_id","action_kind"\)/);
  assert.match(sql, /CREATE UNIQUE INDEX "agent_action_policies_user_action_idx"[^;]*\("user_id","action_kind"\)/);
  assert.match(sql, /CONSTRAINT "agent_action_policies_scope_target" CHECK/);
  for (const column of ["project_id", "user_id"]) {
    assert.match(
      sql,
      new RegExp(`"agent_action_policies" ADD CONSTRAINT [^;]*FOREIGN KEY \\("${column}"\\) REFERENCES [^;]* ON DELETE cascade`),
      `deleting the ${column} owner must delete its settings`,
    );
  }
});

test("0029 records the branch creator without touching existing branches", async () => {
  const sql = await readMigration("0029_docs_branch_creator.sql");

  for (const column of ["created_by_client_id", "created_by_client_name"]) {
    assert.match(
      sql,
      new RegExp(`"docs_branches" ADD COLUMN "${column}" text;`),
      `${column} must be nullable: existing and dashboard branches have no client`,
    );
  }
  assert.match(sql, /CONSTRAINT "docs_branches_creator_client_complete" CHECK/);
  assert.ok(!/UPDATE\s+"docs_branches"/i.test(sql), "no existing branch changes");
});

test("0031 adds the email tables without touching existing invites", async () => {
  const sql = await readMigration("0031_email.sql");

  assert.match(sql, /"team_invites" ADD COLUMN "invited_email" text;/, "invite links without an email stay valid");
  assert.ok(!/UPDATE\s+"team_invites"/i.test(sql), "no existing invite changes");
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "email_deliveries_dedupe_key_idx"[^;]*\("dedupe_key"\)/,
    "one delivery for each dedupe key",
  );
  assert.match(
    sql,
    /CREATE INDEX "email_deliveries_due_idx"[^;]*\("status","next_attempt_at"\) WHERE "email_deliveries"\."status" in \('queued', 'sending'\)/,
    "the sweeper reads only open deliveries",
  );
  assert.match(
    sql,
    /"email_deliveries" ADD CONSTRAINT [^;]*FOREIGN KEY \("recipient_user_id"\) REFERENCES [^;]* ON DELETE set null/,
    "deleting a user keeps the delivery log",
  );
  assert.match(
    sql,
    /"email_preferences" ADD CONSTRAINT [^;]*FOREIGN KEY \("user_id"\) REFERENCES [^;]* ON DELETE cascade/,
    "deleting a user deletes their preferences",
  );
});

test("0032 adds the domain check time without touching existing domains", async () => {
  const sql = await readMigration("0032_docs_domain_checks.sql");

  assert.match(sql, /"docs_domains" ADD COLUMN "last_checked_at" timestamp with time zone;/, "nullable: never checked");
  assert.ok(!/UPDATE\s+"docs_domains"/i.test(sql), "no existing domain changes");
  assert.match(
    sql,
    /CREATE INDEX "docs_domains_status_check_idx"[^;]*\("verification_status","last_checked_at"\) WHERE "docs_domains"\."kind" = 'custom_domain'/,
    "the cron reads only provisioned custom domains",
  );
});

test("0038 keeps every usage row", async () => {
  const sql = await readMigration("0038_usage_records_kept.sql");

  assert.match(
    sql,
    /"generation_usage_records" ALTER COLUMN "expires_at" DROP NOT NULL/,
    "new usage rows have no expiry",
  );
  assert.match(
    sql,
    /UPDATE "generation_usage_records" SET "expires_at" = NULL/,
    "an older cron finds no expired usage row",
  );
  assert.ok(
    !/DELETE\s+FROM\s+"generation_usage_records"/i.test(sql),
    "usage rows are kept for billing",
  );
});

test("0039 adds the retention columns as nullable and only queues work", async () => {
  const sql = await readMigration("0039_version_retention.sql");

  assert.match(sql, /ADD COLUMN "preview_replaced_at" timestamp with time zone;/);
  assert.match(sql, /ADD COLUMN "artifacts_collected_at" timestamp with time zone;/);
  assert.ok(
    !/SET "artifacts_collected_at"/.test(sql),
    "only the collector decides that a version is collected",
  );
  assert.ok(!/DELETE\s+FROM/i.test(sql), "the backfill deletes nothing");
  assert.match(
    sql,
    /'docs_retired_version'[\s\S]*ON CONFLICT \("target", "resource_key"\) DO NOTHING/,
    "an open entry keeps its schedule",
  );
});

test("0046 creates only billing objects, and billing rows outlive their owners", async () => {
  const sql = await readMigration("0046_billing.sql");

  assert.ok(!/\bDROP\b/i.test(sql), "the billing migration drops nothing");
  for (const match of sql.matchAll(/ALTER TABLE "([a-z_]+)"/g)) {
    assert.match(
      match[1],
      /^(billing_|credit_|payg_)/,
      `the billing migration must not alter ${match[1]}`,
    );
  }
  for (const match of sql.matchAll(
    /FOREIGN KEY \("[a-z_]+"\) REFERENCES "public"\."(user|teams|projects|generation_jobs)"\("id"\) ON DELETE ([a-z ]+) ON UPDATE/g,
  )) {
    assert.equal(
      match[2],
      "set null",
      `a deletion in ${match[1]} must never remove a billing record`,
    );
  }
  for (const table of [
    "credit_ledger_entries",
    "credit_grants",
    "payg_invoices",
    "billing_subscriptions",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `"${table}_account_id_billing_accounts_id_fk"[^;]*ON DELETE restrict`,
      ),
      `${table} rows are kept for 7 years`,
    );
  }
});
