import type { SourceProvider } from "@doxahq/contracts";
import { createDb, schema } from "@doxahq/db";
import { and, eq } from "drizzle-orm";
import type { Env } from "../env";
import { withDocsCacheInvalidation } from "./docs-cache-mutation";
import { retireReplacedPreview } from "./docs-version-retirement";

export interface ClosePreviewChannelInput {
  projectId: string;
  provider: SourceProvider;
  changeExternalId: string;
  closedAt: Date;
}

export interface PreviewChannelCloser {
  /**
   * Takes the preview of an ended pull request offline. Returns the number of
   * channels that it closed; 0 when there was nothing left to close.
   */
  closeForChange(input: ClosePreviewChannelInput): Promise<number>;
}

/**
 * Closes the preview channel of a pull request that was closed or merged.
 *
 * The channel stops pointing at its version, so its hostname no longer
 * resolves, the version stops counting as referenced, and the retention
 * policy keeps it promotable for its window from `closedAt`. The hostname
 * purge commits with the change. A new preview of a reopened pull request
 * takes the channel back: the completion moves an empty channel and sets it
 * active again.
 */
export class PreviewChannelClosureRepository implements PreviewChannelCloser {
  private readonly db;

  constructor(private readonly env: Env) {
    this.db = createDb(env);
  }

  async closeForChange(input: ClosePreviewChannelInput): Promise<number> {
    return withDocsCacheInvalidation(this.db, this.env, async (tx, enqueue) => {
      const channels = await tx
        .select({
          id: schema.docsPreviewChannels.id,
          siteId: schema.docsPreviewChannels.siteId,
          hostname: schema.docsPreviewChannels.hostname,
          currentVersionId: schema.docsPreviewChannels.currentVersionId,
          lifecycleState: schema.docsPreviewChannels.lifecycleState,
        })
        .from(schema.docsPreviewChannels)
        .where(
          and(
            eq(schema.docsPreviewChannels.projectId, input.projectId),
            eq(schema.docsPreviewChannels.provider, input.provider),
            eq(schema.docsPreviewChannels.changeExternalId, input.changeExternalId),
          ),
        )
        // A preview completion moves the same row; the lock orders the two.
        .for("update");

      let closed = 0;
      for (const channel of channels) {
        if (channel.lifecycleState === "closed" && channel.currentVersionId === null) {
          continue;
        }
        await tx
          .update(schema.docsPreviewChannels)
          .set({ lifecycleState: "closed", currentVersionId: null, updatedAt: input.closedAt })
          .where(eq(schema.docsPreviewChannels.id, channel.id));
        if (channel.currentVersionId) {
          await retireReplacedPreview(
            tx,
            { siteId: channel.siteId, versionId: channel.currentVersionId },
            input.closedAt,
            "preview_closed",
          );
        }
        await enqueue({ siteId: channel.siteId, hostname: channel.hostname });
        closed += 1;
      }
      return closed;
    });
  }
}
