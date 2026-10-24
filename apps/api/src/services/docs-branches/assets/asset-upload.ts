import {
  DOCS_ASSET_LIMITS,
  docsAssetArtifactPath,
  docsAssetNameFromArtifactPath,
  docsAssetUrlPath,
  type DocsAssetContentType,
} from "@doxahq/contracts/docs-assets";
import type { DocsContentEditOrigin } from "@doxahq/contracts";
import { sha256Hex } from "@doxahq/docs-engine";
import { createValidationIssue } from "@doxahq/site-config";
import type { Env } from "../../../env";
import {
  DocsBranchesRepository,
  type DocsBranchStore,
  type StoredDocsBranch,
} from "../../../repositories/docs-branches";
import { DocsVersionGcEntriesRepository } from "../../../repositories/docs-version-gc-entries";
import { DocsContentError } from "../../docs-content/errors";
import {
  createR2DocsContentStore,
  type DocsContentStore,
} from "../../docs-content/store";
import type { StorageLimitsService } from "../../entitlements";
import { freePlanStorageLimits } from "../../free-plan-entitlements";
import { SiteConfigValidationError } from "../../site-config-validation";
import { BranchResolver, type ResolvedBranchContext } from "../branch-resolver";
import { prepareDocsAsset, type PreparedDocsAsset } from "./asset-content";
import { assetBaseName, assetNameCandidates } from "./asset-name";
import { encodeBranchAssetPointer } from "./asset-pointer";
import { branchAssets, type BranchAsset } from "./branch-assets";

// One attempt can go to starting the hidden branch of `main`.
const WRITE_ATTEMPTS = 4;
const MAX_NAME_CANDIDATES = 1_000;

export interface UploadBranchAssetInput {
  userId: string;
  projectId: string;
  branch: string;
  origin: DocsContentEditOrigin;
  fileName: string;
  bytes: Uint8Array;
}

export interface UploadedBranchAsset {
  /** The path that pages use, for example `/assets/diagram.png`. */
  path: string;
  contentType: DocsAssetContentType;
  size: number;
  sanitized: boolean;
  reused: boolean;
  revision: number;
}

/** The upload folder of one asset, before its change row exists. */
export interface BranchAssetFolder {
  siteId: string;
  versionId: string;
  branchId: string;
}

export interface DocsBranchAssetUploadDeps {
  branches: Pick<
    DocsBranchStore,
    | "resolveForUser"
    | "listChanges"
    | "writeChanges"
    | "getOrCreateHiddenBranch"
  >;
  store: Pick<DocsContentStore, "listKeys" | "versionSize" | "openVersion">;
  storageLimits: StorageLimitsService;
  /**
   * Records the folder for garbage collection before it is written. The
   * collector keeps it while a change row of the branch points to it.
   */
  registerFolder(folder: BranchAssetFolder): Promise<unknown>;
  createId?: () => string;
}

/**
 * Adds an image to a branch. The image goes live with the next approved
 * publish of the branch, like a page edit. An upload to `main` goes to the
 * caller's hidden branch, which starts on demand like an edit to `main`.
 *
 * A new upload never replaces another file: a name in use on the branch or
 * on its base gets a numeric suffix, and the result returns the final path.
 * The same bytes under a name the branch already has return that path again.
 */
export class DocsBranchAssetUpload {
  private readonly resolver: BranchResolver;

  constructor(private readonly deps: DocsBranchAssetUploadDeps) {
    this.resolver = new BranchResolver(deps.branches);
  }

  static fromEnv(env: Env): DocsBranchAssetUpload {
    const gcEntries = new DocsVersionGcEntriesRepository(env);
    return new DocsBranchAssetUpload({
      branches: new DocsBranchesRepository(env),
      store: createR2DocsContentStore(env.DOCS_BUCKET),
      storageLimits: freePlanStorageLimits,
      registerFolder: (folder) => gcEntries.enqueueBranchAssetFolder(folder),
    });
  }

  async upload(input: UploadBranchAssetInput): Promise<UploadedBranchAsset> {
    const prepared = prepareDocsAsset(input.bytes);
    const sha256 = await sha256Hex(prepared.bytes);
    const baseName = assetBaseName(input.fileName);
    let written: { name: string; folderVersionId: string } | null = null;

    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const context = await this.resolver.resolve({
        userId: input.userId,
        projectId: input.projectId,
        branchRef: input.branch,
      });
      if (!context.branch && context.branchRef === "main") {
        const created = await this.deps.branches.getOrCreateHiddenBranch({
          userId: input.userId,
          projectId: input.projectId,
        });
        if (!created) {
          throw new DocsContentError("branch_not_found", "Branch not found.");
        }
        continue;
      }
      const branch = requireBranch(context);
      const assets = branchAssets(await this.deps.branches.listChanges(input));
      const choice = await this.chooseName(context, assets, {
        baseName,
        prepared,
        sha256,
      });

      if (choice.kind === "reused") {
        return this.result(choice.name, prepared, branch.revision, true);
      }

      if (assets.length >= DOCS_ASSET_LIMITS.maxFilesPerBranch) {
        throw new DocsContentError(
          "asset_limit_reached",
          `A branch can add at most ${DOCS_ASSET_LIMITS.maxFilesPerBranch} images.`,
          { maxFiles: DOCS_ASSET_LIMITS.maxFilesPerBranch },
        );
      }

      await this.assertStorageQuota(input.projectId, context, assets, prepared);

      // A retry after a concurrent write reuses the folder of the same name.
      const folderVersionId: string =
        written && written.name === choice.name
          ? written.folderVersionId
          : await this.writeFolder(context, branch, choice.name, prepared);
      written = { name: choice.name, folderVersionId };

      const content = encodeBranchAssetPointer({
        folderVersionId,
        sha256,
        size: prepared.bytes.byteLength,
        contentType: prepared.contentType,
      });
      const contentBytes = new TextEncoder().encode(content);
      const outcome = await this.deps.branches.writeChanges({
        userId: input.userId,
        projectId: input.projectId,
        branchId: branch.id,
        expectedRevision: branch.revision,
        origin: input.origin,
        changes: [
          {
            path: docsAssetArtifactPath(choice.name),
            kind: "upsert",
            content,
            contentSha256: await sha256Hex(contentBytes),
            byteSize: contentBytes.byteLength,
          },
        ],
      });

      if (outcome === "written") {
        return this.result(choice.name, prepared, branch.revision + 1, false);
      }
      // A publish or a discard can delete the hidden branch meanwhile. The
      // next attempt starts a new one.
      if (outcome === "not_found" && context.branchRef === "main") continue;
      if (outcome === "not_found") {
        throw new DocsContentError("branch_not_found", "Branch not found.");
      }
      if (outcome === "too_many_changes" || outcome === "branch_too_large") {
        throw new SiteConfigValidationError([createValidationIssue(outcome)]);
      }
      // revision_changed: another write landed first. Decide again.
    }

    throw new DocsContentError(
      "conflict",
      "The branch changed while the image was being saved. Try again.",
    );
  }

  private async chooseName(
    context: ResolvedBranchContext,
    assets: readonly BranchAsset[],
    upload: { baseName: string; prepared: PreparedDocsAsset; sha256: string },
  ): Promise<{ kind: "new" | "reused"; name: string }> {
    const onBranch = new Map(assets.map((asset) => [asset.name, asset]));
    const assetPrefix = `${context.basePrefix}/assets/`;
    const onBase = new Set(
      (await this.deps.store.listKeys(assetPrefix)).flatMap((key) => {
        const name = docsAssetNameFromArtifactPath(
          key.slice(context.basePrefix.length + 1),
        );
        return name ? [name] : [];
      }),
    );
    let tried = 0;

    for (const name of assetNameCandidates(
      upload.baseName,
      upload.prepared.extension,
    )) {
      const existing = onBranch.get(name);
      if (existing?.pointer.sha256 === upload.sha256) {
        return { kind: "reused", name };
      }
      if (!existing && !onBase.has(name)) return { kind: "new", name };
      if (++tried >= MAX_NAME_CANDIDATES) break;
    }

    throw new DocsContentError(
      "asset_invalid",
      "No free image name is left for this file name. Use another name.",
    );
  }

  /**
   * Uploads count with the version size against the plan storage: the base
   * version, the images the branch already adds, and this file.
   */
  private async assertStorageQuota(
    projectId: string,
    context: ResolvedBranchContext,
    assets: readonly BranchAsset[],
    prepared: PreparedDocsAsset,
  ): Promise<void> {
    const [limits, versionBytes] = await Promise.all([
      this.deps.storageLimits.getStorageLimits(projectId),
      this.deps.store.versionSize(context.basePrefix),
    ]);
    const usedBytes =
      (versionBytes ?? 0) +
      assets.reduce((sum, asset) => sum + asset.pointer.size, 0);

    if (usedBytes + prepared.bytes.byteLength > limits.maxDocsStorageBytes) {
      throw new DocsContentError(
        "storage_quota_exceeded",
        "This image would take the documentation over the storage of the plan.",
        { usedBytes, limitBytes: limits.maxDocsStorageBytes },
      );
    }
  }

  private async writeFolder(
    context: ResolvedBranchContext,
    branch: StoredDocsBranch,
    name: string,
    prepared: PreparedDocsAsset,
  ): Promise<string> {
    const folder = {
      siteId: context.main.siteId,
      versionId: (this.deps.createId ?? (() => crypto.randomUUID()))(),
      branchId: branch.id,
    };
    await this.deps.registerFolder(folder);
    const version = await this.deps.store.openVersion({
      siteId: folder.siteId,
      versionId: folder.versionId,
    });
    await version.put(
      docsAssetArtifactPath(name),
      prepared.bytes,
      prepared.contentType,
    );
    await version.commit();
    return folder.versionId;
  }

  private result(
    name: string,
    prepared: PreparedDocsAsset,
    revision: number,
    reused: boolean,
  ): UploadedBranchAsset {
    return {
      path: docsAssetUrlPath(name),
      contentType: prepared.contentType,
      size: prepared.bytes.byteLength,
      sanitized: prepared.sanitized,
      reused,
      revision,
    };
  }
}

function requireBranch(context: ResolvedBranchContext): StoredDocsBranch {
  if (!context.branch) {
    throw new DocsContentError("branch_not_found", "Branch not found.");
  }
  return context.branch;
}
