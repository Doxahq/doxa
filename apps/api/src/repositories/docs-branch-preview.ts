import { and, eq } from "drizzle-orm";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";
import { contentVersionStatePrefix } from "@doxahq/docs-engine";

import type {
  StoredBranchChange,
  StoredDocsBranch,
} from "./docs-branch-records";
import { toStoredBranch, toStoredChange } from "./docs-branch-records";
import {
  enqueueDocsOrphanVersionPrefix,
  enqueueDocsPreviewVersion,
} from "./docs-version-gc-entries";
import {
  compareAndSetPreviewVersion,
  createChannelHostnameCandidates,
  createRandomHex,
  ensureBranchPreviewChannelWithCandidates,
} from "./preview-channels";
import {
  createDocsNamespaceLookup,
  isHostnameAvailable,
} from "../services/docs-namespace";
import { DocsContentError } from "../services/docs-content/errors";
import { nextDocsVersionNumber } from "./docs-version-numbers";

const PREVIEW_BUILD_INTERVAL_MS = 10_000;

export interface BranchPreviewMaterialization {
  artifactPrefix: string;
  manifestPath: string;
}

export interface LockedBranchPreview {
  siteId: string;
  projectName: string;
  projectSlug: string;
  branch: StoredDocsBranch;
  baseArtifactPrefix: string;
  changes: readonly StoredBranchChange[];
}

export interface DocsBranchPreviewStore {
  build(input: {
    userId: string;
    projectId: string;
    branch: string;
    versionId: string;
    docsBaseDomain: string | undefined;
    materialize(
      context: LockedBranchPreview,
    ): Promise<BranchPreviewMaterialization>;
  }): Promise<{ hostname: string; versionId: string }>;
}

type PreviewTransaction = Parameters<Parameters<DoxaDb["transaction"]>[0]>[0];
type PreviewReader = DoxaDb | PreviewTransaction;

export class DocsBranchPreviewRepository implements DocsBranchPreviewStore {
  private readonly db;

  constructor(
    env: DbEnv,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = createDb(env);
  }

  /**
   * Builds a preview in three steps, so no lock is held while R2 is written.
   *
   * 1. Read the branch snapshot and check the rate limit, without locks.
   * 2. Queue the new folder as an orphan, then write the artifacts. The queue
   *    entry commits first, so a failed build leaves no untracked folder.
   * 3. Lock the site and the branch for a short commit that moves the channel.
   */
  async build(
    input: Parameters<DocsBranchPreviewStore["build"]>[0],
  ): ReturnType<DocsBranchPreviewStore["build"]> {
    const snapshot = await readPreviewSnapshot(this.db, input);
    const channel = await getBranchChannel(this.db, snapshot.branch.id);

    assertPreviewRateLimit(channel?.updatedAt ?? null, this.now());
    await enqueueDocsOrphanVersionPrefix(this.db, {
      siteId: snapshot.siteId,
      versionId: input.versionId,
    });

    const materialized = await input.materialize(snapshot);

    return this.db.transaction((tx) =>
      commitBranchPreview(tx, input, snapshot, materialized, this.now()),
    );
  }
}

async function commitBranchPreview(
  tx: PreviewTransaction,
  input: Parameters<DocsBranchPreviewStore["build"]>[0],
  snapshot: LockedBranchPreview,
  materialized: BranchPreviewMaterialization,
  now: Date,
): Promise<{ hostname: string; versionId: string }> {
  const branch = await lockSiteAndBranch(tx, input);

  if (!branch || branch.id !== snapshot.branch.id) {
    throw new DocsContentError("branch_not_found", "Branch not found.");
  }

  if (
    branch.previewRevision !== null &&
    branch.previewRevision > snapshot.branch.revision
  ) {
    throw new DocsContentError(
      "conflict",
      "A newer preview of this branch finished first.",
    );
  }

  await insertPreviewVersion(tx, {
    siteId: snapshot.siteId,
    versionId: input.versionId,
    baseVersionId: snapshot.branch.baseVersionId,
    artifactPrefix: materialized.artifactPrefix,
    manifestPath: materialized.manifestPath,
  });

  const hostname = await moveBranchPreviewChannel(tx, input, snapshot, now);
  return { hostname, versionId: input.versionId };
}

async function moveBranchPreviewChannel(
  tx: PreviewTransaction,
  input: Parameters<DocsBranchPreviewStore["build"]>[0],
  context: LockedBranchPreview,
  now: Date,
): Promise<string> {
  const channel = await ensureBranchChannel(tx, { ...input, context });
  const advanced = await compareAndSetPreviewVersion(tx, {
    channelId: channel.id,
    expectedVersionId: channel.currentVersionId,
    versionId: input.versionId,
  });

  if (!advanced) {
    throw new Error("The branch preview changed during the build.");
  }

  if (channel.currentVersionId) {
    await enqueueDocsPreviewVersion(
      tx,
      { siteId: context.siteId, versionId: channel.currentVersionId },
      "preview_replaced",
    );
  }

  // The preview shows the revision that was built. A later edit makes the
  // status report the preview as out of date.
  await tx
    .update(schema.docsBranches)
    .set({ previewRevision: context.branch.revision, updatedAt: now })
    .where(eq(schema.docsBranches.id, context.branch.id));

  return channel.hostname;
}

/** Reads the branch, its base, and its changes. Takes no lock. */
async function readPreviewSnapshot(
  db: DoxaDb,
  input: { userId: string; projectId: string; branch: string },
): Promise<LockedBranchPreview> {
  const owned = await findOwnedSite(db, input);

  if (!owned) {
    throw new DocsContentError("branch_not_found", "Branch not found.");
  }

  const branch = await findBranch(db, {
    siteId: owned.siteId,
    userId: input.userId,
    branchRef: input.branch,
    lock: false,
  });

  if (!branch) {
    throw new DocsContentError("branch_not_found", "Branch not found.");
  }

  const [baseVersion, changes] = await Promise.all([
    findBaseVersion(db, branch),
    listBranchChanges(db, branch.id),
  ]);

  if (!baseVersion) {
    throw new DocsContentError("branch_not_found", "Branch base not found.");
  }

  return {
    siteId: owned.siteId,
    projectName: owned.projectName,
    projectSlug: owned.projectSlug,
    branch,
    baseArtifactPrefix: baseVersion.artifactPrefix,
    changes,
  };
}

/** Locks the site, then the branch, in the order every branch write uses. */
async function lockSiteAndBranch(
  tx: PreviewTransaction,
  input: { userId: string; projectId: string; branch: string },
): Promise<StoredDocsBranch | null> {
  const owned = await findOwnedSite(tx, input);

  if (!owned) {
    return null;
  }

  await tx
    .select({ id: schema.docsSites.id })
    .from(schema.docsSites)
    .where(eq(schema.docsSites.id, owned.siteId))
    .for("update")
    .limit(1);

  return findBranch(tx, {
    siteId: owned.siteId,
    userId: input.userId,
    branchRef: input.branch,
    lock: true,
  });
}

async function findOwnedSite(
  db: PreviewReader,
  input: { userId: string; projectId: string },
) {
  const [owned] = await db
    .select({
      siteId: schema.docsSites.id,
      projectName: schema.projects.name,
      projectSlug: schema.projects.slug,
    })
    .from(schema.projects)
    .innerJoin(
      schema.docsSites,
      eq(schema.docsSites.projectId, schema.projects.id),
    )
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.userId, input.userId),
      ),
    )
    .limit(1);

  return owned ?? null;
}

async function findBranch(
  db: PreviewReader,
  input: {
    siteId: string;
    userId: string;
    branchRef: string;
    lock: boolean;
  },
): Promise<StoredDocsBranch | null> {
  const identity =
    input.branchRef === "main"
      ? and(
          eq(schema.docsBranches.kind, "hidden"),
          eq(schema.docsBranches.ownerUserId, input.userId),
        )
      : and(
          eq(schema.docsBranches.kind, "named"),
          eq(schema.docsBranches.id, input.branchRef),
        );
  const query = db
    .select()
    .from(schema.docsBranches)
    .where(
      and(
        eq(schema.docsBranches.siteId, input.siteId),
        eq(schema.docsBranches.ownerUserId, input.userId),
        identity,
      ),
    )
    .limit(1);
  const [row] = input.lock ? await query.for("update") : await query;

  return row ? toStoredBranch(row) : null;
}

async function findBaseVersion(
  db: PreviewReader,
  branch: StoredDocsBranch,
): Promise<{ artifactPrefix: string } | null> {
  const [version] = await db
    .select({ artifactPrefix: schema.docsVersions.artifactPrefix })
    .from(schema.docsVersions)
    .where(
      and(
        eq(schema.docsVersions.id, branch.baseVersionId),
        eq(schema.docsVersions.siteId, branch.siteId),
      ),
    )
    .limit(1);

  return version ?? null;
}

async function listBranchChanges(
  db: PreviewReader,
  branchId: string,
): Promise<StoredBranchChange[]> {
  const rows = await db
    .select()
    .from(schema.docsBranchChanges)
    .where(eq(schema.docsBranchChanges.branchId, branchId));

  return rows.map(toStoredChange);
}

async function insertPreviewVersion(
  tx: PreviewTransaction,
  input: {
    siteId: string;
    versionId: string;
    baseVersionId: string;
    artifactPrefix: string;
    manifestPath: string;
  },
): Promise<void> {
  await tx.insert(schema.docsVersions).values({
    id: input.versionId,
    siteId: input.siteId,
    versionNumber: await nextDocsVersionNumber(tx, {
      siteId: input.siteId,
      channel: "preview",
    }),
    status: "published",
    channel: "preview",
    artifactPrefix: input.artifactPrefix,
    manifestPath: input.manifestPath,
    baselineVersionId: input.baseVersionId,
    generationStatePrefix: contentVersionStatePrefix(
      input.siteId,
      input.versionId,
    ),
  });
}

async function ensureBranchChannel(
  tx: PreviewTransaction,
  input: {
    projectId: string;
    docsBaseDomain: string | undefined;
    context: LockedBranchPreview;
  },
) {
  const branchName =
    input.context.branch.kind === "named" ? input.context.branch.name : "edits";
  const randomSuffix = createRandomHex(8);
  const namespace = createDocsNamespaceLookup(tx);
  const hostnameCandidates = await createChannelHostnameCandidates({
    stem: `${input.context.projectSlug}-br-${branchName}`,
    identity: input.context.branch.id,
    requiredSuffix: randomSuffix,
    docsBaseDomain: input.docsBaseDomain,
    isAvailable: (candidate) => isHostnameAvailable(namespace, candidate),
  });

  return ensureBranchPreviewChannelWithCandidates(tx, {
    projectId: input.projectId,
    siteId: input.context.siteId,
    branchId: input.context.branch.id,
    hostnameCandidates,
  });
}

async function getBranchChannel(db: PreviewReader, branchId: string) {
  const [channel] = await db
    .select({
      currentVersionId: schema.docsPreviewChannels.currentVersionId,
      updatedAt: schema.docsPreviewChannels.updatedAt,
    })
    .from(schema.docsPreviewChannels)
    .where(eq(schema.docsPreviewChannels.branchId, branchId))
    .limit(1);

  return channel ?? null;
}

function assertPreviewRateLimit(lastBuiltAt: Date | null, now: Date): void {
  if (isPreviewBuildRateLimited(lastBuiltAt, now)) {
    throw new DocsContentError(
      "preview_rate_limited",
      "Wait 10 seconds before you build this preview again.",
    );
  }
}

export function isPreviewBuildRateLimited(
  lastBuiltAt: Date | null,
  now: Date,
): boolean {
  return Boolean(
    lastBuiltAt &&
    now.getTime() - lastBuiltAt.getTime() < PREVIEW_BUILD_INTERVAL_MS,
  );
}

