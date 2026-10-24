import { schema } from "@doxahq/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import {
  previewConcurrencyKey,
  productionConcurrencyKey,
} from "../../src/repositories/jobs";

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function indexConfig(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
) {
  return getTableConfig(table).indexes.find((index) => index.config.name === name)?.config;
}

function indexColumnNames(
  config: NonNullable<ReturnType<typeof indexConfig>>,
): Array<string | null> {
  return config.columns.map((column) =>
    "name" in column ? (column.name ?? null) : null,
  );
}

describe("Doxabot control-plane schema", () => {
  test("stores automation settings and webhook delivery outcomes", () => {
    expect(columnNames(schema.doxabotAutomationSettings)).toEqual(
      expect.arrayContaining([
        "project_id",
        "enabled",
        "updated_by_user_id",
        "created_at",
        "updated_at",
      ]),
    );
    expect(columnNames(schema.scmWebhookDeliveries)).toEqual(
      expect.arrayContaining([
        "provider",
        "delivery_id",
        "event_name",
        "repository_external_id",
        "payload_hash",
        "normalized_event",
        "generation_job_id",
        "queue_published_at",
        "status",
        "ignore_reason",
        "error_code",
        "processed_at",
      ]),
    );

    const deliveryIdentity = indexConfig(
      schema.scmWebhookDeliveries,
      "scm_webhook_deliveries_provider_delivery_idx",
    );
    expect(deliveryIdentity?.unique).toBe(true);
    expect(deliveryIdentity && indexColumnNames(deliveryIdentity)).toEqual([
      "provider",
      "delivery_id",
    ]);
    expect(schema.scmWebhookDeliveries.normalizedEvent.notNull).toBe(true);
    expect(schema.scmWebhookDeliveries.queuePublishedAt.notNull).toBe(
      false,
    );
  });

  test("stores change proposals and one preview channel per change", () => {
    expect(columnNames(schema.scmChangeProposals)).toEqual(
      expect.arrayContaining([
        "project_id",
        "provider",
        "repository_external_id",
        "installation_external_id",
        "external_id",
        "display_number",
        "draft",
        "state",
        "base_revision",
        "head_revision",
        "source_updated_at",
        "last_source_tree_hash",
      ]),
    );
    expect(
      schema.scmChangeProposals.installationExternalId.notNull,
    ).toBe(true);

    const previewIdentity = indexConfig(
      schema.docsPreviewChannels,
      "docs_preview_channels_project_site_change_idx",
    );
    const previewHostname = indexConfig(
      schema.docsPreviewChannels,
      "docs_preview_channels_hostname_idx",
    );
    expect(previewIdentity?.unique).toBe(true);
    expect(previewIdentity && indexColumnNames(previewIdentity)).toEqual([
      "project_id",
      "site_id",
      "provider",
      "change_external_id",
    ]);
    expect(previewHostname?.unique).toBe(true);
    expect(previewHostname && indexColumnNames(previewHostname)).toEqual([
      "hostname",
    ]);
  });

  test("scopes active-job uniqueness by production or preview channel", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const productionKey = productionConcurrencyKey(projectId);
    const firstPreviewKey = previewConcurrencyKey({
      projectId,
      provider: "github",
      changeExternalId: "41",
    });
    const secondPreviewKey = previewConcurrencyKey({
      projectId,
      provider: "github",
      changeExternalId: "42",
    });

    expect(productionKey).toBe(`publish:${projectId}`);
    expect(productionConcurrencyKey(projectId)).toBe(productionKey);
    expect(firstPreviewKey).not.toBe(secondPreviewKey);
    expect(firstPreviewKey).not.toBe(productionKey);

    const activeConcurrency = indexConfig(
      schema.generationJobs,
      "generation_jobs_active_concurrency_idx",
    );
    expect(activeConcurrency?.unique).toBe(true);
    expect(activeConcurrency && indexColumnNames(activeConcurrency)).toEqual([
      "concurrency_key",
    ]);
    expect(activeConcurrency?.where).toBeDefined();
    expect(
      indexConfig(schema.generationJobs, "generation_jobs_active_project_idx"),
    ).toBeUndefined();
  });

  test("records generation provenance on jobs and documentation versions", () => {
    expect(columnNames(schema.generationJobs)).toEqual(
      expect.arrayContaining([
        "trigger",
        "publication_mode",
        "source_provider",
        "source_installation_external_id",
        "source_author_external_id",
        "source_author_handle",
        "source_author_avatar_url",
        "change_proposal_id",
        "change_external_id",
        "baseline_revision",
        "target_revision",
        "source_tree_hash",
        "baseline_version_id",
        "agent_model",
        "planner_model",
        "writer_model",
        "planning_fingerprint",
        "writing_fingerprint",
        "generation_profile",
        "generator_fingerprint",
        "idempotency_key",
        "concurrency_key",
        "external_review_run_id",
        "superseded_by_job_id",
      ]),
    );
    expect(schema.generationJobs.requestedByUserId.notNull).toBe(false);
    expect(
      schema.generationJobs.sourceInstallationExternalId.notNull,
    ).toBe(false);

    expect(columnNames(schema.generationUsageRecords)).toEqual(
      expect.arrayContaining([
        "call_id",
        "job_id",
        "project_id",
        "stage_execution_id",
        "stage",
        "operation",
        "model_role",
        "model",
        "page_id",
        "page_retry",
        "attempt",
        "iteration",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "cost_usd",
        "expires_at",
      ]),
    );
    expect(
      indexConfig(
        schema.generationUsageRecords,
        "generation_usage_records_call_id_idx",
      )?.unique,
    ).toBe(true);

    // Spend attribution must outlive the generation. `project_id` carries it,
    // so it is required, and `job_id` is cleared when the generation is deleted.
    expect(schema.generationUsageRecords.projectId.notNull).toBe(true);
    expect(schema.generationUsageRecords.jobId.notNull).toBe(false);
    expect(
      indexConfig(
        schema.generationUsageRecords,
        "generation_usage_records_project_id_idx",
      ),
    ).toBeDefined();

    expect(columnNames(schema.generationRepairDiagnostics)).toEqual(
      expect.arrayContaining([
        "diagnostic_id",
        "job_id",
        "page_id",
        "rule",
        "message",
        "line",
        "column",
        "snippet",
        "draft_key",
        "draft_sha256",
        "draft_truncated",
        "repair_kind",
        "repair_succeeded",
        "writer_attempt",
        "max_attempts",
        "rejection_reason",
        "validation_issue_codes",
        "expires_at",
      ]),
    );

    expect(columnNames(schema.docsVersions)).toEqual(
      expect.arrayContaining([
        "channel",
        "source_revision",
        "source_tree_hash",
        "baseline_version_id",
        "generator_fingerprint",
        "generation_state_prefix",
      ]),
    );
    expect(schema.docsVersions.generationStatePrefix.notNull).toBe(true);
  });
});
