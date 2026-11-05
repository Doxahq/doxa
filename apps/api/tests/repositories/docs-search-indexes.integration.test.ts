import {
  docsSearchIndexEntryKey,
  type DocsSearchIndexResource,
} from "@doxahq/contracts/storage-gc";
import { createDb, schema } from "@doxahq/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { enqueueDocsSearchIndexTask } from "../../src/repositories/docs-search-index-tasks";
import {
  DocsSearchIndexesRepository,
  enqueueDocsSearchIndexCollection,
  listCollectableDocsSearchIndexes,
} from "../../src/repositories/docs-search-indexes";
import type { ClaimedDocsSearchTask } from "../../src/services/docs-search/index-worker";
import { DOCS_SEARCH_COLLECT_GRACE_SECONDS } from "../../src/services/docs-search/limits";

/**
 * The search task states and their races, on a real Postgres, because locks and
 * conflict rules are the point. To run it, migrate an empty database and set
 * DOCS_SEARCH_TEST_DATABASE_URL. It deletes every project in that database, so
 * never point it at a database you need.
 */
const databaseUrl = process.env.DOCS_SEARCH_TEST_DATABASE_URL;
const FACTS = { documents: 1, indexedBytes: 10 };

describe.skipIf(!databaseUrl)("docs search index tasks", () => {
  // Vitest runs this body for a skipped suite too. The client connects only on
  // its first query, so a placeholder address is safe without a test database.
  const env = {
    DATABASE_URL: databaseUrl ?? "postgresql://not-set.invalid/skipped",
  } as never;
  const db = createDb(env);
  const repository = new DocsSearchIndexesRepository(env);
  const tasks = schema.docsSearchIndexes;
  let userId: string;
  let projectId: string;
  let siteId: string;
  let versionNumber = 0;

  async function newVersion(): Promise<string> {
    versionNumber += 1;
    const id = crypto.randomUUID();
    await db.insert(schema.docsVersions).values({
      id,
      siteId,
      versionNumber,
      artifactPrefix: `sites/${siteId}/versions/${id}`,
      manifestPath: `sites/${siteId}/versions/${id}/manifest.json`,
      generationStatePrefix: `sites/${siteId}/generation/${id}`,
    });
    return id;
  }

  /** What every publish does: move the pointer and open the task, together. */
  async function publish(versionId: string): Promise<string | null> {
    return db.transaction(async (tx) => {
      await tx
        .update(schema.docsSites)
        .set({ publishedVersionId: versionId })
        .where(eq(schema.docsSites.id, siteId));
      return enqueueDocsSearchIndexTask(tx, { siteId, versionId });
    });
  }

  async function claim(versionId: string): Promise<ClaimedDocsSearchTask> {
    const claimed = await repository.claimNext();
    expect(claimed?.versionId).toBe(versionId);
    return claimed!;
  }

  /** Runs the claimed task of a version through to its result. */
  async function build(versionId: string, provider: "typesense" | "minisearch") {
    const task = await claim(versionId);
    if (provider === "typesense") {
      expect(await repository.beginWrite(task, provider)).toBeTruthy();
    }
    await repository.complete(task, {
      provider,
      facts: provider === "typesense" ? FACTS : null,
    });
  }

  /** Publishes a version and finishes its task with this provider. */
  async function finish(provider: "typesense" | "minisearch") {
    const versionId = await newVersion();
    await publish(versionId);
    await build(versionId, provider);
    return versionId;
  }

  const row = async (versionId: string) => {
    const [found] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.siteId, siteId), eq(tasks.versionId, versionId)));
    return found;
  };
  const site = async () => {
    const [found] = await db
      .select({
        provider: schema.docsSites.searchProvider,
        indexKey: schema.docsSites.searchIndexKey,
      })
      .from(schema.docsSites)
      .where(eq(schema.docsSites.id, siteId));
    return found;
  };
  const resource = (indexKey: string | null | undefined) =>
    ({
      siteId,
      provider: "typesense",
      indexKey: indexKey!,
    }) satisfies DocsSearchIndexResource;
  const gcEntry = async (indexKey: string | null | undefined) => {
    const [entry] = await db
      .select()
      .from(schema.storageGcEntries)
      .where(
        eq(
          schema.storageGcEntries.resourceKey,
          docsSearchIndexEntryKey(resource(indexKey)),
        ),
      );
    return entry;
  };
  const makeRechecksDue = (versionId: string) =>
    db
      .update(tasks)
      .set({ updatedAt: sql`now() - interval '2 hours'` })
      .where(eq(tasks.versionId, versionId));

  const clearTestData = async () => {
    await db.execute(sql`delete from storage_gc_entries`);
    await db.execute(sql`delete from projects`);
  };

  // `claimNext` reads every site, so each test starts with an empty table.
  beforeEach(async () => {
    await clearTestData();
    userId = crypto.randomUUID();
    projectId = crypto.randomUUID();
    siteId = crypto.randomUUID();
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
    await db
      .insert(schema.docsSites)
      .values({ id: siteId, projectId, slug: `test-${siteId}` });
  });

  afterAll(clearTestData);

  describe("a normal publish", () => {
    it("points the site at the index only after it exists", async () => {
      const versionId = await newVersion();
      await publish(versionId);
      const task = await claim(versionId);
      const indexKey = await repository.beginWrite(task, "typesense");
      expect(await site()).toMatchObject({ provider: "minisearch", indexKey: null });

      await repository.complete(task, { provider: "typesense", facts: FACTS });
      expect(await site()).toEqual({ provider: "typesense", indexKey });
      expect((await row(versionId))?.status).toBe("ready");
    });

    it("keeps serving the previous index until the new one is ready", async () => {
      const older = await finish("typesense");
      const olderKey = (await row(older))?.indexKey;
      const newer = await newVersion();
      await publish(newer);

      // The sweep must not retire the index that the site serves.
      await repository.sweep();
      expect(await site()).toMatchObject({ indexKey: olderKey });
      expect((await row(older))?.status).toBe("ready");
      expect(await gcEntry(olderKey)).toBeUndefined();

      await build(newer, "typesense");
      expect((await site())?.indexKey).toBe((await row(newer))?.indexKey);
      expect((await row(older))?.status).toBe("retired");
      expect(await gcEntry(olderKey)).toBeDefined();
    });

    it("gives a task to one worker", async () => {
      await publish(await newVersion());
      const [first, second] = await Promise.all([
        repository.claimNext(),
        repository.claimNext(),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
    });

    it("claims only the live version", async () => {
      const older = await newVersion();
      await publish(older);
      const newer = await newVersion();
      await publish(newer);
      expect((await repository.claimNext())?.versionId).toBe(newer);
      expect(await repository.claimNext()).toBeNull();
    });

    it("keeps the key across a retry, so no partial index is left", async () => {
      const versionId = await newVersion();
      await publish(versionId);
      const first = await claim(versionId);
      const key = await repository.beginWrite(first, "typesense");
      await repository.fail(first, "TimeoutError");
      await db
        .update(tasks)
        .set({ nextAttemptAt: sql`now()` })
        .where(eq(tasks.versionId, versionId));

      const second = await claim(versionId);
      expect(await repository.beginWrite(second, "typesense")).toBe(key);
    });
  });

  // Codex S2 and the third review: a failed replacement must not leave old
  // results forever, however often the owner publishes.
  describe("a replacement that keeps failing", () => {
    const staleSince = async () => {
      const [found] = await db
        .select({ value: schema.docsSites.searchIndexStaleSince })
        .from(schema.docsSites)
        .where(eq(schema.docsSites.id, siteId));
      return found?.value ?? null;
    };
    const endTimeLimit = () =>
      db
        .update(schema.docsSites)
        .set({ searchIndexStaleSince: sql`now() - interval '2 hours'` })
        .where(eq(schema.docsSites.id, siteId));

    it("keeps the previous index within the time limit", async () => {
      const older = await finish("typesense");
      const olderKey = (await row(older))?.indexKey;
      await publish(await newVersion());
      expect(await staleSince()).toBeNull();

      await repository.sweep();
      expect(await staleSince()).not.toBeNull();
      expect(await site()).toEqual({ provider: "typesense", indexKey: olderKey });
    });

    it("moves the site to browser search after the time limit", async () => {
      const older = await finish("typesense");
      const olderKey = (await row(older))?.indexKey;
      await publish(await newVersion());
      await repository.sweep();
      await endTimeLimit();

      await repository.sweep();
      expect(await site()).toEqual({ provider: "minisearch", indexKey: null });
      expect(await staleSince()).toBeNull();
      // The old index is free to go, in the same sweep.
      expect((await row(older))?.status).toBe("retired");
      expect(await gcEntry(olderKey)).toBeDefined();
    });

    // PRODUCT REGRESSION GUARDRAIL: a publish must not extend the time limit.
    it("does not restart the time limit on a new publish", async () => {
      const older = await finish("typesense");
      const olderKey = (await row(older))?.indexKey;
      await publish(await newVersion());
      await repository.sweep();
      const started = await staleSince();

      await publish(await newVersion());
      await repository.sweep();
      expect(await staleSince()).toEqual(started);
      expect((await site())?.indexKey).toBe(olderKey);

      await endTimeLimit();
      await publish(await newVersion());
      await repository.sweep();
      expect(await site()).toEqual({ provider: "minisearch", indexKey: null });
    });

    it("does not restart the time limit on a retry or a new publish of that version", async () => {
      await finish("typesense");
      const newer = await newVersion();
      await publish(newer);
      await repository.sweep();
      const started = await staleSince();

      await repository.fail(await claim(newer), "Boom");
      await db
        .update(tasks)
        .set({ status: "failed" })
        .where(eq(tasks.versionId, newer));
      await repository.reopen((await row(newer))!.id);
      await db
        .update(tasks)
        .set({ status: "failed" })
        .where(eq(tasks.versionId, newer));
      await publish(newer);
      await repository.sweep();

      expect(await staleSince()).toEqual(started);
    });

    it("moves back and clears the timer when the build finally works", async () => {
      await finish("typesense");
      const newer = await newVersion();
      await publish(newer);
      await repository.sweep();
      await endTimeLimit();
      await repository.sweep();

      await build(newer, "typesense");
      expect(await site()).toEqual({
        provider: "typesense",
        indexKey: (await row(newer))?.indexKey,
      });
      expect(await staleSince()).toBeNull();
    });

    it("gives a later replacement its own time limit", async () => {
      await finish("typesense");
      const caughtUp = await newVersion();
      await publish(caughtUp);
      await repository.sweep();
      await endTimeLimit();
      await build(caughtUp, "typesense");
      const caughtUpKey = (await row(caughtUp))?.indexKey;

      await publish(await newVersion());
      await repository.sweep();
      expect((await site())?.indexKey).toBe(caughtUpKey);
    });

    it("clears the timer when the owner restores the version that it serves", async () => {
      const older = await finish("typesense");
      await publish(await newVersion());
      await repository.sweep();
      await endTimeLimit();

      expect(await publish(older)).toBeNull();
      expect(await staleSince()).toBeNull();
      await repository.sweep();
      expect((await site())?.indexKey).toBe((await row(older))?.indexKey);
    });

    // Codex round 4: a repair finishes with the same index, so no target changes.
    it("clears the timer when a repair of the live version finishes", async () => {
      const live = await finish("typesense");
      const liveKey = (await row(live))?.indexKey;
      await repository.reopen((await row(live))!.id);
      await publish(await newVersion());
      await repository.sweep();
      await publish(live);
      await endTimeLimit();

      const task = await claim(live);
      await repository.beginWrite(task, "typesense");
      await repository.complete(task, { provider: "typesense", facts: FACTS });
      expect(await staleSince()).toBeNull();

      await publish(await newVersion());
      await repository.sweep();
      expect((await site())?.indexKey).toBe(liveKey);
    });

    it("clears the timer in a sweep while a repair of the live version still runs", async () => {
      const live = await finish("typesense");
      await repository.reopen((await row(live))!.id);
      await publish(await newVersion());
      await repository.sweep();
      await publish(live);
      expect(await staleSince()).not.toBeNull();

      await repository.sweep();
      expect(await staleSince()).toBeNull();
    });

    it("does not start the time limit on a site that serves its live version", async () => {
      const live = await finish("typesense");
      await repository.sweep();
      expect(await staleSince()).toBeNull();
      expect((await site())?.indexKey).toBe((await row(live))?.indexKey);
    });

    it("starts the time limit when a restore falls behind", async () => {
      const first = await finish("typesense");
      const second = await finish("typesense");
      const secondKey = (await row(second))?.indexKey;

      // `first` is retired, so this restore builds again. The site keeps serving
      // `second` until then.
      await publish(first);
      await repository.sweep();
      expect(await staleSince()).not.toBeNull();
      expect((await site())?.indexKey).toBe(secondKey);
    });

    it("ends with the new index, whichever of a build and the sweep goes first", async () => {
      await finish("typesense");
      for (let round = 0; round < 5; round += 1) {
        const newer = await newVersion();
        await publish(newer);
        await repository.sweep();
        await endTimeLimit();
        const task = await claim(newer);
        const indexKey = await repository.beginWrite(task, "typesense");

        await Promise.all([
          repository.complete(task, { provider: "typesense", facts: FACTS }),
          repository.sweep(),
        ]);

        expect(await site()).toEqual({ provider: "typesense", indexKey });
        expect(await staleSince()).toBeNull();
        expect(await gcEntry(indexKey)).toBeUndefined();
      }
    });
  });

  describe("restores", () => {
    // Codex finding 3.
    it("applies a browser result in the restore transaction", async () => {
      const browser = await finish("minisearch");
      await finish("typesense");
      expect((await site())?.provider).toBe("typesense");

      expect(await publish(browser)).toBeNull();
      expect(await site()).toEqual({ provider: "minisearch", indexKey: null });
      expect((await row(browser))?.status).toBe("skipped");
    });

    it("retires the replaced index after a browser restore", async () => {
      const browser = await finish("minisearch");
      const remote = await finish("typesense");
      const remoteKey = (await row(remote))?.indexKey;
      await publish(browser);

      await repository.sweep();
      expect((await row(remote))?.status).toBe("retired");
      expect(await gcEntry(remoteKey)).toBeDefined();
    });

    it("reuses a ready index when nothing replaced it yet", async () => {
      const older = await finish("typesense");
      const olderKey = (await row(older))?.indexKey;
      await publish(await newVersion());

      expect(await publish(older)).toBeNull();
      expect(await site()).toEqual({ provider: "typesense", indexKey: olderKey });
      expect((await row(older))?.status).toBe("ready");
    });

    it("reopens a version that was replaced before anything was written", async () => {
      const older = await newVersion();
      await publish(older);
      await publish(await newVersion());
      await repository.sweep();
      expect((await row(older))?.status).toBe("superseded");

      expect(await publish(older)).toBe((await row(older))?.id);
      expect((await row(older))?.status).toBe("pending");
    });

    // Codex findings 5 and R2: a delete cannot hit a rebuilt index, because a
    // rebuild has another name. It also needs no waiting period.
    it("builds a retired version under a new name, at once", async () => {
      const older = await finish("typesense");
      const oldKey = (await row(older))?.indexKey;
      await finish("typesense");
      const entry = await gcEntry(oldKey);
      expect(entry).toBeDefined();

      await publish(older);
      expect(await row(older)).toMatchObject({
        status: "pending",
        indexKey: null,
        provider: null,
      });

      const task = await claim(older);
      const newKey = await repository.beginWrite(task, "typesense");
      expect(newKey).not.toBe(oldKey);
      await repository.complete(task, { provider: "typesense", facts: FACTS });

      // The old index is free to go, and the new one is protected.
      expect(await repository.isIndexInUse(resource(oldKey))).toBe(false);
      expect(await repository.isIndexInUse(resource(newKey))).toBe(true);
      expect((await site())?.indexKey).toBe(newKey);
    });

    // Codex R2: republish and restore again before the first delete has run.
    it("stays safe through repeated publishes and restores", async () => {
      const first = await finish("typesense");
      const keys = [(await row(first))?.indexKey];
      for (let round = 0; round < 3; round += 1) {
        await finish("typesense");
        await publish(first);
        await build(first, "typesense");
        keys.push((await row(first))?.indexKey);
      }
      expect(new Set(keys).size).toBe(keys.length);
      const liveKey = (await site())?.indexKey;
      expect(liveKey).toBe(keys.at(-1));
      for (const key of keys.slice(0, -1)) {
        expect(await repository.isIndexInUse(resource(key))).toBe(false);
      }
      expect(await repository.isIndexInUse(resource(liveKey))).toBe(true);
    });
  });

  describe("replaced versions", () => {
    // Codex finding 4.
    it("collects a partial index of a replaced version", async () => {
      const older = await newVersion();
      await publish(older);
      const task = await claim(older);
      const key = await repository.beginWrite(task, "typesense");
      await repository.fail(task, "TimeoutError");
      await publish(await newVersion());

      await repository.sweep();
      expect((await row(older))?.status).toBe("retired");
      expect(await gcEntry(key)).toBeDefined();
    });

    // Codex finding 4.
    it("retires a late finisher, not the live version", async () => {
      const older = await newVersion();
      await publish(older);
      const lateTask = await claim(older);
      const lateKey = await repository.beginWrite(lateTask, "typesense");

      const live = await finish("typesense");
      const liveKey = (await row(live))?.indexKey;
      await repository.complete(lateTask, { provider: "typesense", facts: FACTS });

      expect((await row(live))?.status).toBe("ready");
      expect(await gcEntry(liveKey)).toBeUndefined();
      expect((await row(older))?.status).toBe("retired");
      expect(await gcEntry(lateKey)).toBeDefined();
      expect((await site())?.indexKey).toBe(liveKey);
    });

    it("refuses a write when the version left production", async () => {
      const older = await newVersion();
      await publish(older);
      const task = await claim(older);
      await publish(await newVersion());
      expect(await repository.beginWrite(task, "typesense")).toBeNull();
      expect((await row(older))?.indexKey).toBeNull();
    });

    it("refuses a write when the claim is gone", async () => {
      const versionId = await newVersion();
      await publish(versionId);
      const task = await claim(versionId);
      expect(
        await repository.beginWrite({ ...task, claimToken: "other" }, "typesense"),
      ).toBeNull();
    });
  });

  // Codex R4: these hold a real row lock, so the order is forced.
  describe("completion against a publish in progress", () => {
    it("waits for the publish, then treats the version as replaced", async () => {
      const older = await newVersion();
      await publish(older);
      const task = await claim(older);
      await repository.beginWrite(task, "typesense");
      const newer = await newVersion();

      let completion: Promise<void> | undefined;
      await db.transaction(async (tx) => {
        await tx
          .update(schema.docsSites)
          .set({ publishedVersionId: newer })
          .where(eq(schema.docsSites.id, siteId));
        // The publish holds the site row, so this must wait for its commit.
        completion = repository.complete(task, {
          provider: "typesense",
          facts: FACTS,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect((await row(older))?.status).toBe("running");
        await enqueueDocsSearchIndexTask(tx, { siteId, versionId: newer });
      });
      await completion;

      expect((await row(older))?.status).toBe("retired");
      expect(await site()).toMatchObject({ provider: "minisearch", indexKey: null });
    });

    it("never lets an old finisher overwrite what the live version chose", async () => {
      const older = await newVersion();
      await publish(older);
      const lateTask = await claim(older);
      await repository.beginWrite(lateTask, "typesense");

      await finish("minisearch");
      await repository.complete(lateTask, { provider: "typesense", facts: FACTS });

      expect(await site()).toEqual({ provider: "minisearch", indexKey: null });
    });
  });

  // Codex findings 1 and R1.
  describe("project deletion", () => {
    async function deleteProject() {
      await db.transaction(async (tx) => {
        for (const item of await listCollectableDocsSearchIndexes(tx, siteId)) {
          await enqueueDocsSearchIndexCollection(tx, item, "project_deleted");
        }
        await tx.delete(schema.projects).where(eq(schema.projects.id, projectId));
      });
    }

    it("waits for a writer that was running when the project was deleted", async () => {
      const versionId = await newVersion();
      await publish(versionId);
      const task = await claim(versionId);
      const indexKey = await repository.beginWrite(task, "typesense");

      await deleteProject();
      expect(await row(versionId)).toBeUndefined();

      // The stalled writer finishes after the deletion, without an error.
      await repository.complete(task, { provider: "typesense", facts: FACTS });

      const entry = await gcEntry(indexKey);
      const waitSeconds =
        (new Date(String(entry?.eligibleAt)).getTime() - Date.now()) / 1000;
      expect(waitSeconds).toBeGreaterThan(DOCS_SEARCH_COLLECT_GRACE_SECONDS - 60);
      expect(await repository.isIndexInUse(resource(indexKey))).toBe(false);
    });

    // R1: an old entry that is already due cannot shorten this wait, because the
    // running writer has its own new key, and so its own new entry.
    it("gives a restored build its own wait, whatever older entries do", async () => {
      const first = await finish("typesense");
      const oldKey = (await row(first))?.indexKey;
      await finish("typesense");
      await db
        .update(schema.storageGcEntries)
        .set({ eligibleAt: sql`now()`, nextAttemptAt: sql`now()` })
        .where(
          eq(
            schema.storageGcEntries.resourceKey,
            docsSearchIndexEntryKey(resource(oldKey)),
          ),
        );

      await publish(first);
      const task = await claim(first);
      const newKey = await repository.beginWrite(task, "typesense");
      await deleteProject();

      const entry = await gcEntry(newKey);
      const waitSeconds =
        (new Date(String(entry?.eligibleAt)).getTime() - Date.now()) / 1000;
      expect(newKey).not.toBe(oldKey);
      expect(waitSeconds).toBeGreaterThan(DOCS_SEARCH_COLLECT_GRACE_SECONDS - 60);
    });

    it("stops a writer that starts after the project is deleted", async () => {
      const versionId = await newVersion();
      await publish(versionId);
      const task = await claim(versionId);
      await deleteProject();
      expect(await repository.beginWrite(task, "typesense")).toBeNull();
    });

    // Forces the order: the deletion holds the site row, and a completion waits.
    it("makes a completion wait for a deletion in progress", async () => {
      const versionId = await newVersion();
      await publish(versionId);
      const task = await claim(versionId);
      const indexKey = await repository.beginWrite(task, "typesense");

      let completion: Promise<void> | undefined;
      await db.transaction(async (tx) => {
        await tx
          .select({ id: schema.docsSites.id })
          .from(schema.docsSites)
          .where(eq(schema.docsSites.id, siteId))
          .for("update");
        completion = repository.complete(task, {
          provider: "typesense",
          facts: FACTS,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        // A completion that locked the task first holds it now, and this fails.
        await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.id, task.id))
          .for("update", { noWait: true });
        const items = await listCollectableDocsSearchIndexes(tx, siteId);
        for (const item of items) {
          await enqueueDocsSearchIndexCollection(tx, item, "project_deleted");
        }
        await tx.delete(schema.projects).where(eq(schema.projects.id, projectId));
      });
      await completion;

      expect(await row(versionId)).toBeUndefined();
      expect(await gcEntry(indexKey)).toBeDefined();
    });

    it("does not deadlock with a worker that holds the site row", async () => {
      const versionId = await newVersion();
      await publish(versionId);
      const task = await claim(versionId);
      await repository.beginWrite(task, "typesense");
      await Promise.all([
        repository.complete(task, { provider: "typesense", facts: FACTS }),
        deleteProject(),
      ]);
      expect(await row(versionId)).toBeUndefined();
    });
  });

  // Codex finding 2.
  describe("provider changes on the live version", () => {
    it("collects the index when the site moves to browser search", async () => {
      const versionId = await finish("typesense");
      const key = (await row(versionId))?.indexKey;
      await repository.reopen((await row(versionId))!.id);
      await build(versionId, "minisearch");

      expect(await row(versionId)).toMatchObject({
        status: "skipped",
        provider: "minisearch",
        indexKey: null,
      });
      expect(await site()).toEqual({ provider: "minisearch", indexKey: null });
      expect(await gcEntry(key)).toBeDefined();
      expect(await repository.isIndexInUse(resource(key))).toBe(false);
    });

    // Codex R2: back to Typesense while a delete of the old index may be running.
    it("builds under a new name when the site moves back", async () => {
      const versionId = await finish("typesense");
      const oldKey = (await row(versionId))?.indexKey;
      await repository.reopen((await row(versionId))!.id);
      await build(versionId, "minisearch");

      await repository.reopen((await row(versionId))!.id);
      await build(versionId, "typesense");
      const newKey = (await row(versionId))?.indexKey;

      expect(newKey).not.toBe(oldKey);
      expect((await site())?.indexKey).toBe(newKey);
      expect(await repository.isIndexInUse(resource(oldKey))).toBe(false);
    });

    it("rebuilds the same version under its own key after a lost index", async () => {
      const versionId = await finish("typesense");
      const key = (await row(versionId))?.indexKey;
      await repository.reopen((await row(versionId))!.id);
      await build(versionId, "typesense");

      expect((await row(versionId))?.indexKey).toBe(key);
      expect(await gcEntry(key)).toBeUndefined();
    });
  });

  describe("scheduler", () => {
    it("lists a live version for a recheck after the interval", async () => {
      const versionId = await finish("typesense");
      const key = (await row(versionId))?.indexKey;
      expect(
        (await repository.listRechecks()).map((item) => item.versionId),
      ).not.toContain(versionId);

      await makeRechecksDue(versionId);
      const due = await repository.listRechecks();
      const item = due.find((entry) => entry.versionId === versionId);
      expect(item).toMatchObject({
        provider: "typesense",
        indexKey: key,
        siteProvider: "typesense",
        siteIndexKey: key,
        status: "ready",
      });

      await repository.markRechecked(item!.id);
      expect(
        (await repository.listRechecks()).map((entry) => entry.versionId),
      ).not.toContain(versionId);
    });

    // Codex R5: a row that keeps failing cannot hold the rows behind it.
    it("moves a checked row behind the other sites", async () => {
      const firstVersion = await finish("minisearch");
      const firstSite = siteId;

      // A second site, with an older check than the first.
      const secondSite = crypto.randomUUID();
      await db.insert(schema.docsSites).values({
        id: secondSite,
        projectId: (await db.insert(schema.projects).values({
          id: crypto.randomUUID(),
          userId,
          name: "Second",
          slug: `second-${secondSite}`,
        } as never).returning({ id: schema.projects.id }))[0]!.id,
        slug: `second-${secondSite}`,
      });
      siteId = secondSite;
      const secondVersion = await finish("minisearch");
      siteId = firstSite;

      await db
        .update(tasks)
        .set({ updatedAt: sql`now() - interval '3 hours'` })
        .where(eq(tasks.versionId, firstVersion));
      await db
        .update(tasks)
        .set({ updatedAt: sql`now() - interval '2 hours'` })
        .where(eq(tasks.versionId, secondVersion));

      const due = await repository.listRechecks();
      expect(due.map((item) => item.versionId)).toEqual([firstVersion, secondVersion]);

      await repository.markRechecked(due[0]!.id);
      expect((await repository.listRechecks()).map((item) => item.versionId)).toEqual([
        secondVersion,
      ]);
    });

    it("adds a task for a live version that has none", async () => {
      const versionId = await newVersion();
      await db
        .update(schema.docsSites)
        .set({ publishedVersionId: versionId })
        .where(eq(schema.docsSites.id, siteId));
      await repository.sweep();
      expect((await row(versionId))?.status).toBe("pending");
    });

    it("ends a task that used every attempt", async () => {
      const versionId = await newVersion();
      await publish(versionId);
      await db
        .update(tasks)
        .set({
          status: "running",
          attempts: 6,
          leaseExpiresAt: sql`now() - interval '1 minute'`,
        })
        .where(eq(tasks.versionId, versionId));
      expect(await repository.claimNext()).toBeNull();
      await repository.sweep();
      expect((await row(versionId))?.status).toBe("failed");
    });

    it("keeps a browser-search site's shape: no index anywhere", async () => {
      const versionId = await finish("minisearch");
      expect(await row(versionId)).toMatchObject({ status: "skipped", indexKey: null });
      expect(await site()).toEqual({ provider: "minisearch", indexKey: null });
    });
  });
});
