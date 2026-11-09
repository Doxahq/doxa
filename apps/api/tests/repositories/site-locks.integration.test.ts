import { createDb, schema } from "@doxahq/db";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DocsBranchesRepository } from "../../src/repositories/docs-branches";
import { ProjectsRepository } from "../../src/repositories/projects";
import { encodeBranchAssetPointer } from "../../src/services/docs-branches/assets/asset-pointer";

/**
 * The upload quotas and their locks on a real Postgres, because the locks are
 * the point. To run it, migrate a database and set
 * SITE_LOCKS_TEST_DATABASE_URL. It adds its own user and project, and removes
 * only those.
 */
const databaseUrl = process.env.SITE_LOCKS_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("site upload locks", () => {
  // Vitest runs this body for a skipped suite too. The client connects only on
  // its first query, so a placeholder address is safe without a test database.
  const env = {
    DATABASE_URL: databaseUrl ?? "postgresql://not-set.invalid/skipped",
  } as never;
  const db = createDb(env);
  const repository = new DocsBranchesRepository(env);
  const projects = new ProjectsRepository(env);
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const siteId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const branchIds = Array.from({ length: 12 }, () => crypto.randomUUID());
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function assetChange(name: string, size: number, folderVersionId = crypto.randomUUID()) {
    const content = encodeBranchAssetPointer({
      folderVersionId,
      sha256: "a".repeat(64),
      size,
      contentType: "image/png",
    });
    return {
      path: `assets/${name}.png`,
      kind: "upsert" as const,
      content,
      contentSha256: "b".repeat(64),
      byteSize: content.length,
    };
  }

  async function revisionOf(branchId: string): Promise<number> {
    const [row] = await db
      .select({ revision: schema.docsBranches.revision })
      .from(schema.docsBranches)
      .where(eq(schema.docsBranches.id, branchId));
    return row?.revision ?? 0;
  }

  async function write(branchId: string, name: string, size: number, maxBytes: number) {
    return repository.writeChanges({
      userId,
      projectId,
      branchId,
      expectedRevision: await revisionOf(branchId),
      origin: "mcp",
      assetQuota: { addedBytes: size, maxBytes },
      changes: [assetChange(name, size)],
    });
  }

  /** Holds the lock of the site until the returned function is called. */
  async function holdSiteAssetLock() {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = projects.withSiteAssetLock(siteId, () => released);
    await pause(100);
    return { release, held };
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
    await db.insert(schema.docsSites).values({ id: siteId, projectId, slug: `test-${siteId}` });
    await db.insert(schema.docsVersions).values({
      id: versionId,
      siteId,
      versionNumber: 1,
      artifactPrefix: `sites/${siteId}/versions/${versionId}`,
      manifestPath: `sites/${siteId}/versions/${versionId}/manifest.json`,
      generationStatePrefix: `sites/${siteId}/generation/${versionId}`,
    });
    await db.insert(schema.docsBranches).values(
      branchIds.map((id, index) => ({
        id,
        siteId,
        kind: "named" as const,
        name: `agent-lock-${index}`,
        ownerUserId: userId,
        baseVersionId: versionId,
      })) as never,
    );
  });

  beforeEach(async () => {
    await db
      .delete(schema.docsBranchChanges)
      .where(inArray(schema.docsBranchChanges.branchId, branchIds));
  });

  afterAll(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  });

  describe("the image quota of a site", () => {
    it("lets parallel uploads to different branches store exactly the budget", async () => {
      for (let round = 0; round < 3; round++) {
        await db
          .delete(schema.docsBranchChanges)
          .where(inArray(schema.docsBranchChanges.branchId, branchIds));

        const outcomes = await Promise.all(
          branchIds.map((branchId, index) => write(branchId, `race-${round}-${index}`, 100, 500)),
        );

        expect(outcomes.filter((outcome) => outcome === "written")).toHaveLength(5);
        expect(outcomes.filter((outcome) => outcome === "storage_quota_exceeded")).toHaveLength(7);
        expect(await repository.siteBranchAssetBytes(siteId)).toBe(500);
      }
    }, 60_000);

    it("accepts a file that fills the budget and refuses one byte more", async () => {
      expect(await write(branchIds[0]!, "over", 501, 500)).toBe("storage_quota_exceeded");
      expect(await write(branchIds[0]!, "fits", 500, 500)).toBe("written");
      expect(await repository.siteBranchAssetBytes(siteId)).toBe(500);
    });

    it("counts rows of a copied branch once, and a row that is no pointer as nothing", async () => {
      const shared = crypto.randomUUID();
      const rows = [
        { branchId: branchIds[0]!, ...assetChange("a", 70, shared) },
        { branchId: branchIds[1]!, ...assetChange("a", 70, shared) },
        {
          branchId: branchIds[2]!,
          path: "assets/note.mdx",
          kind: "upsert" as const,
          content: "plain text",
          contentSha256: "c".repeat(64),
          byteSize: 10,
        },
      ];
      await db
        .insert(schema.docsBranchChanges)
        .values(rows.map((row) => ({ ...row, updatedByUserId: userId, origin: "mcp" })));

      expect(await repository.siteBranchAssetBytes(siteId)).toBe(70);
    });

    it("answers busy when the lock stays taken, and writes nothing", async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${4_244}::int, hashtext(${siteId}))`);
        expect(await write(branchIds[0]!, "busy", 10, 500)).toBe("quota_busy");
      });
      expect(await repository.siteBranchAssetBytes(siteId)).toBe(0);
    }, 15_000);
  });

  describe("the site asset lock", () => {
    it("lets one holder run at a time", async () => {
      let running = 0;
      let peak = 0;
      await Promise.all(
        Array.from({ length: 10 }, () =>
          projects.withSiteAssetLock(siteId, async () => {
            running += 1;
            peak = Math.max(peak, running);
            await pause(40);
            running -= 1;
          }),
        ),
      );
      expect(peak).toBe(1);
    }, 30_000);

    it("does not make another site wait", async () => {
      const { release, held } = await holdSiteAssetLock();
      const started = performance.now();
      await projects.withSiteAssetLock(crypto.randomUUID(), async () => undefined);
      const waited = performance.now() - started;
      release();
      await held;
      expect(waited).toBeLessThan(150);
    });

    it("keeps the connection pool free while requests wait", async () => {
      const { release, held } = await holdSiteAssetLock();
      const waiters = Array.from({ length: 60 }, () =>
        projects.withSiteAssetLock(siteId, async () => undefined),
      );
      await pause(300);

      const started = performance.now();
      await db.execute(sql`select 1`);
      const waited = performance.now() - started;

      release();
      await Promise.allSettled([held, ...waiters]);
      expect(waited).toBeLessThan(500);
    }, 30_000);

    it("answers busy after a stuck holder, and an error frees the lock", async () => {
      const { release, held } = await holdSiteAssetLock();
      await expect(projects.withSiteAssetLock(siteId, async () => 1)).rejects.toMatchObject({
        code: "asset_upload_busy",
      });
      release();
      await held;

      await expect(
        projects.withSiteAssetLock(siteId, () => Promise.reject(new Error("boom"))),
      ).rejects.toThrow("boom");
      await expect(projects.withSiteAssetLock(siteId, async () => 2)).resolves.toBe(2);
    }, 20_000);
  });
});
