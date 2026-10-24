import type { DocsPublicationPage } from "@doxahq/contracts/docs-branches";
import type { PublicationAttribution } from "../../repositories/docs-publications";
import type { Env } from "../../env";
import {
  DocsHistoryRepository,
  NO_LONGER_RESTORABLE_MESSAGE,
} from "../../repositories/docs-history";
import { DocsContentError } from "../docs-content/errors";
import {
  createR2DocsContentStore,
  type DocsContentStore,
} from "../docs-content/store";

export class DocsBranchHistory {
  constructor(
    private readonly history: Pick<
      DocsHistoryRepository,
      "list" | "getRestoreCandidate" | "restore"
    >,
    private readonly store: Pick<DocsContentStore, "read">,
  ) {}

  static fromEnv(env: Env): DocsBranchHistory {
    return new DocsBranchHistory(
      new DocsHistoryRepository(env),
      createR2DocsContentStore(env.DOCS_BUCKET),
    );
  }

  async list(input: {
    userId: string;
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<DocsPublicationPage> {
    const { page, manifestPaths } = await this.history.list(input);

    return {
      ...page,
      publications: await Promise.all(
        page.publications.map(async (publication) => {
          const path = manifestPaths.get(publication.id);
          return {
            ...publication,
            canRestore: Boolean(
              publication.canRestore &&
              path &&
              (await this.store.read(path)) !== null,
            ),
          };
        }),
      ),
    };
  }

  async restore(input: {
    userId: string;
    projectId: string;
    publicationId: string;
    expectedMainVersionId: string;
    /** Set when an agent action restores. */
    attribution?: PublicationAttribution;
  }): Promise<{ publicationId: string; versionId: string }> {
    const candidate = await this.history.getRestoreCandidate(input);

    if (!candidate) {
      throw new DocsContentError("not_found", "Publication not found.");
    }

    if (candidate.artifactsCollectedAt !== null) {
      throw new DocsContentError("invalid", NO_LONGER_RESTORABLE_MESSAGE);
    }

    if (
      candidate.channel !== "production" ||
      candidate.status !== "published" ||
      candidate.versionId === candidate.currentVersionId
    ) {
      throw new DocsContentError(
        "invalid",
        "This publication cannot be restored.",
      );
    }

    if ((await this.store.read(candidate.manifestPath)) === null) {
      throw new DocsContentError(
        "invalid",
        "This publication's artifacts are unavailable.",
      );
    }

    return this.history.restore(input);
  }
}
