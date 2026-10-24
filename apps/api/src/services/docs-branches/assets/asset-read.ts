import {
  docsAssetArtifactPath,
  docsAssetContentTypeForName,
  type DocsAssetContentType,
} from "@doxahq/contracts/docs-assets";
import type { Env } from "../../../env";
import {
  DocsBranchesRepository,
  type DocsBranchStore,
} from "../../../repositories/docs-branches";
import {
  createR2DocsContentStore,
  type DocsContentStore,
} from "../../docs-content/store";
import { BranchResolver } from "../branch-resolver";
import { branchAssetFolderPrefix } from "./asset-pointer";
import { branchAssets } from "./branch-assets";

export interface BranchAssetFile {
  bytes: Uint8Array;
  contentType: DocsAssetContentType;
}

export interface DocsBranchAssetReadDeps {
  branches: Pick<DocsBranchStore, "resolveForUser" | "listChanges">;
  store: Pick<DocsContentStore, "readBytes">;
}

/**
 * Reads an image as a branch sees it, for the dashboard editor: the upload
 * of the branch when it adds the name, else the file of its base version.
 * `main` reads the caller's hidden branch, or the published version when the
 * caller has none.
 *
 * Pages link to `/assets/{name}` before the branch is published, and the
 * docs host serves only published versions, so the editor needs this read.
 */
export class DocsBranchAssetRead {
  private readonly resolver: BranchResolver;

  constructor(private readonly deps: DocsBranchAssetReadDeps) {
    this.resolver = new BranchResolver(deps.branches);
  }

  static fromEnv(env: Env): DocsBranchAssetRead {
    return new DocsBranchAssetRead({
      branches: new DocsBranchesRepository(env),
      store: createR2DocsContentStore(env.DOCS_BUCKET),
    });
  }

  /** Null when the name is invalid or the branch does not hold the file. */
  async read(input: {
    userId: string;
    projectId: string;
    branch: string;
    name: string;
  }): Promise<BranchAssetFile | null> {
    const contentType = docsAssetContentTypeForName(input.name);
    if (!contentType) return null;

    const context = await this.resolver.resolve({
      userId: input.userId,
      projectId: input.projectId,
      branchRef: input.branch,
    });
    const path = docsAssetArtifactPath(input.name);
    let key = `${context.basePrefix}/${path}`;

    if (context.branch) {
      const changes = await this.deps.branches.listChanges(input);
      const change = changes.find((row) => row.path === path);
      if (change?.kind === "delete") return null;
      const asset = branchAssets(changes).find((row) => row.path === path);
      if (asset) {
        key = `${branchAssetFolderPrefix(context.main.siteId, asset.pointer)}/${path}`;
      }
    }

    const bytes = await this.deps.store.readBytes(key);
    return bytes ? { bytes, contentType } : null;
  }
}
