import {
  branchRefSchema,
  type BranchRef,
} from "@doxahq/contracts/docs-branches";
import type {
  DocsBranchStore,
  StoredDocsBranch,
} from "../../repositories/docs-branches";
import type { PublishedDocsContentVersion } from "../../repositories/docs-content";
import { DocsContentError } from "../docs-content/errors";

export interface ResolvedBranchContext {
  main: PublishedDocsContentVersion;
  branch: StoredDocsBranch | null;
  basePrefix: string;
  branchRef: BranchRef;
}

export class BranchResolver {
  constructor(
    private readonly branches: Pick<DocsBranchStore, "resolveForUser">,
  ) {}

  async resolve(input: {
    userId: string;
    projectId: string;
    branchRef: string;
  }): Promise<ResolvedBranchContext> {
    const parsed = branchRefSchema.safeParse(input.branchRef);

    if (!parsed.success) {
      throw new DocsContentError("branch_not_found", "Branch not found.");
    }

    const authorized = await this.branches.resolveForUser({
      userId: input.userId,
      projectId: input.projectId,
      branch: parsed.data,
    });

    if (!authorized) {
      throw new DocsContentError("branch_not_found", "Branch not found.");
    }

    const { site, branch, baseArtifactPrefix } = authorized;

    return {
      main: {
        projectId: site.projectId,
        projectName: site.projectName,
        projectSlug: site.projectSlug,
        siteId: site.id,
        versionId: site.mainVersionId,
        versionNumber: site.mainVersionNumber,
        artifactPrefix: site.mainArtifactPrefix,
        manifestPath: `${site.mainArtifactPrefix}/manifest.json`,
        createdAt: site.mainCreatedAt,
      },
      branch,
      basePrefix: baseArtifactPrefix,
      branchRef: parsed.data,
    };
  }
}
