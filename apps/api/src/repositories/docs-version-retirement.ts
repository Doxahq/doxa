import { and, eq } from "drizzle-orm";
import { schema } from "@doxahq/db";
import { generationStateOwnerVersionId } from "@doxahq/docs-engine";
import type { DocsRetiredVersionResource } from "@doxahq/contracts/storage-gc";

import type { DocsMutationTransaction } from "./docs-cache-invalidations";
import {
  enqueueDocsGenerationState,
  enqueueDocsRetiredVersion,
  type RetiredVersionReason,
} from "./docs-version-gc-entries";

/**
 * Queues the folder and the generation state of a version that stopped
 * serving, in the caller's transaction. The collectors decide later; this
 * call only records the intent.
 */
export async function retireDocsVersion(
  tx: DocsMutationTransaction,
  resource: DocsRetiredVersionResource,
  reason: RetiredVersionReason,
): Promise<void> {
  const [version] = await tx
    .select({
      generationStatePrefix: schema.docsVersions.generationStatePrefix,
    })
    .from(schema.docsVersions)
    .where(
      and(
        eq(schema.docsVersions.id, resource.versionId),
        eq(schema.docsVersions.siteId, resource.siteId),
      ),
    )
    .limit(1);
  if (!version) return;

  await enqueueDocsRetiredVersion(tx, resource, reason);
  const stateOwner = generationStateOwnerVersionId(
    resource.siteId,
    version.generationStatePrefix,
  );
  if (stateOwner) {
    await enqueueDocsGenerationState(
      tx,
      { siteId: resource.siteId, versionId: stateOwner },
      reason,
    );
  }
}

/**
 * Records that a newer push moved a pull request preview channel off a
 * version, and queues the version. The retention policy keeps the replaced
 * preview promotable for a few days from this time.
 */
export async function retireReplacedPreview(
  tx: DocsMutationTransaction,
  resource: DocsRetiredVersionResource,
  replacedAt: Date,
): Promise<void> {
  await tx
    .update(schema.docsVersions)
    .set({ previewReplacedAt: replacedAt })
    .where(
      and(
        eq(schema.docsVersions.id, resource.versionId),
        eq(schema.docsVersions.siteId, resource.siteId),
      ),
    );
  await retireDocsVersion(tx, resource, "preview_replaced");
}
