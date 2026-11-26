import { createDb, schema } from "@doxahq/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JobsRepository } from "../../src/repositories/jobs";

/**
 * Which ended preview jobs still have an open pull request check, on a real
 * Postgres: the query and its partial index are the point. To run it, migrate
 * a database and set REVIEW_RUNS_TEST_DATABASE_URL. It adds its own user,
 * project and jobs, and removes only those.
 */
const databaseUrl = process.env.REVIEW_RUNS_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("open checks of ended preview jobs", () => {
  // Vitest runs this body for a skipped suite too. The client connects only on
  // its first query, so a placeholder address is safe without a test database.
  const env = {
    DATABASE_URL: databaseUrl ?? "postgresql://not-set.invalid/skipped",
  } as never;
  const db = createDb(env);
  const jobs = new JobsRepository(env);
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const now = new Date("2026-11-25T18:00:00.000Z");
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  const ids = {
    failedOpen: crypto.randomUUID(),
    cancelledOpen: crypto.randomUUID(),
    failedClosed: crypto.randomUUID(),
    running: crypto.randomUUID(),
    noCheck: crypto.randomUUID(),
    pendingCheck: crypto.randomUUID(),
    endedJustNow: crypto.randomUUID(),
    endedTwoDaysAgo: crypto.randomUUID(),
  };

  async function insertJob(
    id: string,
    values: {
      status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "stopped_credits";
      externalReviewRunId: string | null;
      updatedAt: Date;
      reviewRunCompletedAt?: Date;
    },
  ) {
    await db.insert(schema.generationJobs).values({
      id,
      projectId,
      trigger: "doxabot",
      publicationMode: "preview",
      idempotencyKey: `test:${id}`,
      concurrencyKey: `test:${id}`,
      ...values,
    });
  }

  async function completedAtOf(id: string): Promise<Date | null> {
    const [row] = await db
      .select({ completedAt: schema.generationJobs.reviewRunCompletedAt, updatedAt: schema.generationJobs.updatedAt })
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, id));
    return row?.completedAt ?? null;
  }

  beforeAll(async () => {
    await db.insert(schema.user).values({
      id: userId,
      name: "Test",
      email: `${userId}@example.com`,
      emailVerified: true,
    });
    await db.insert(schema.projects).values({
      id: projectId,
      userId,
      name: "Test",
      slug: `test-${projectId}`,
    } as never);
    await insertJob(ids.failedOpen, { status: "failed", externalReviewRunId: "1001", updatedAt: minutesAgo(30) });
    await insertJob(ids.cancelledOpen, { status: "cancelled", externalReviewRunId: "1002", updatedAt: minutesAgo(10) });
    await insertJob(ids.failedClosed, {
      status: "failed",
      externalReviewRunId: "1003",
      updatedAt: minutesAgo(20),
      reviewRunCompletedAt: minutesAgo(20),
    });
    await insertJob(ids.running, { status: "running", externalReviewRunId: "1004", updatedAt: minutesAgo(40) });
    await insertJob(ids.noCheck, { status: "failed", externalReviewRunId: null, updatedAt: minutesAgo(40) });
    await insertJob(ids.pendingCheck, { status: "failed", externalReviewRunId: "pending:1:claim", updatedAt: minutesAgo(40) });
    await insertJob(ids.endedJustNow, { status: "failed", externalReviewRunId: "1005", updatedAt: minutesAgo(1) });
    await insertJob(ids.endedTwoDaysAgo, { status: "failed", externalReviewRunId: "1006", updatedAt: minutesAgo(48 * 60) });
  });

  afterAll(async () => {
    // Jobs go with their project (on delete cascade).
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  });

  const window = () => ({ endedAfter: minutesAgo(24 * 60), endedBefore: minutesAgo(2), limit: 100 });
  const ourIds: ReadonlySet<string> = new Set(Object.values(ids));
  const ours = (found: string[]) => found.filter((id) => ourIds.has(id));

  it("lists only ended jobs with a stored, open check inside the window, newest first", async () => {
    expect(ours(await jobs.listOpenReviewRunsOfEndedJobs(window()))).toEqual([ids.cancelledOpen, ids.failedOpen]);
  });

  it("records a completed check only for the check that the job stores, and keeps the job's update time", async () => {
    const [before] = await db
      .select({ updatedAt: schema.generationJobs.updatedAt })
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, ids.failedOpen));

    await jobs.markReviewRunCompleted({ jobId: ids.failedOpen, externalRunId: "9999", completedAt: now });
    expect(await completedAtOf(ids.failedOpen)).toBeNull();

    await jobs.markReviewRunCompleted({ jobId: ids.failedOpen, externalRunId: "1001", completedAt: now });
    expect(await completedAtOf(ids.failedOpen)).toEqual(now);

    const [after] = await db
      .select({ updatedAt: schema.generationJobs.updatedAt })
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, ids.failedOpen));
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(ours(await jobs.listOpenReviewRunsOfEndedJobs(window()))).toEqual([ids.cancelledOpen]);
  });

  it("keeps the first completion time when the check is closed again", async () => {
    await jobs.markReviewRunCompleted({ jobId: ids.failedOpen, externalRunId: "1001", completedAt: minutesAgo(-5) });

    expect(await completedAtOf(ids.failedOpen)).toEqual(now);
  });
});
