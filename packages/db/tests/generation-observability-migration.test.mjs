import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  currentDirectory,
  "../migrations/0014_repair_generation_observability_schema.sql",
);
const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://doxa:doxa@localhost:5432/doxa";

test("0014 upgrades the originally applied diagnostics table", async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(`
      create temporary table generation_repair_diagnostics (
        id uuid primary key,
        diagnostic_id uuid not null,
        job_id uuid not null,
        stage_execution_id uuid not null,
        page_id text not null,
        page_title text not null,
        page_retry integer not null,
        attempt integer not null,
        model text not null,
        rule text not null,
        message text not null,
        line integer,
        "column" integer,
        snippet text,
        draft_key text not null,
        draft_sha256 text not null,
        draft_truncated boolean not null,
        repair_kind text not null,
        repair_succeeded boolean,
        recorded_at timestamp with time zone not null,
        expires_at timestamp with time zone not null,
        created_at timestamp with time zone not null
      )
    `);
    await client.query(`
      insert into generation_repair_diagnostics (
        id,
        diagnostic_id,
        job_id,
        stage_execution_id,
        page_id,
        page_title,
        page_retry,
        attempt,
        model,
        rule,
        message,
        draft_key,
        draft_sha256,
        draft_truncated,
        repair_kind,
        repair_succeeded,
        recorded_at,
        expires_at,
        created_at
      ) values (
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
        'quickstart',
        'Quickstart',
        0,
        2,
        'writer-model',
        'unexpected-character',
        'Unexpected character',
        '_generation-diagnostics/draft.mdx',
        '${"a".repeat(64)}',
        false,
        'model_patch',
        null,
        now(),
        now() + interval '30 days',
        now()
      )
    `);

    await client.query(await readFile(migrationPath, "utf8"));

    const columns = await client.query(`
      select attname
      from pg_attribute
      where attrelid = 'pg_temp.generation_repair_diagnostics'::regclass
        and attnum > 0
        and not attisdropped
      order by attname
    `);
    assert.deepEqual(
      columns.rows
        .map((row) => row.attname)
        .filter((name) => [
          "max_attempts",
          "rejection_reason",
          "validation_issue_codes",
          "writer_attempt",
        ].includes(name)),
      [
        "max_attempts",
        "rejection_reason",
        "validation_issue_codes",
        "writer_attempt",
      ],
    );

    const migrated = await client.query(`
      select
        writer_attempt,
        max_attempts,
        repair_succeeded,
        validation_issue_codes
      from generation_repair_diagnostics
    `);
    assert.deepEqual(migrated.rows, [{
      writer_attempt: 2,
      max_attempts: 2,
      repair_succeeded: false,
      validation_issue_codes: [],
    }]);
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
});
