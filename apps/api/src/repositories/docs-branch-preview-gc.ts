import { eq } from "drizzle-orm";
import { schema, type DoxaDb } from "@doxahq/db";

import { enqueueDocsPreviewVersion } from "./docs-version-gc-entries";

type PreviewGcTransaction = Parameters<Parameters<DoxaDb["transaction"]>[0]>[0];

/**
 * Queues the preview folder of a branch that the caller deletes in the same
 * transaction. The deletion cascades to the preview channel, so the hostname
 * stops resolving when the transaction commits.
 *
 * Returns the work-list entries that the caller collects after the commit.
 */
export async function retireBranchPreview(
  tx: PreviewGcTransaction,
  input: { branchId: string; siteId: string },
): Promise<string[]> {
  const [channel] = await tx
    .select({ versionId: schema.docsPreviewChannels.currentVersionId })
    .from(schema.docsPreviewChannels)
    .where(eq(schema.docsPreviewChannels.branchId, input.branchId))
    .limit(1);

  if (!channel?.versionId) {
    return [];
  }

  const entryId = await enqueueDocsPreviewVersion(
    tx,
    { siteId: input.siteId, versionId: channel.versionId },
    "branch_erased",
  );

  return entryId ? [entryId] : [];
}
