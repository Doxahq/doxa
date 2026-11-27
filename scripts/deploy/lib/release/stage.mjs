// Stages one Worker of the release: uploads a version that gets no traffic
// until the flip, and adds it to the manifest with the version it replaces.
// A Worker that a staged version cannot carry deploys live instead (see
// `liveDeployReason`). scripts/deploy/release.mjs, the renderer deploy and the API
// deploy all stage through here.

import { requireStagedManifest, withService, writeManifestFile } from "./manifest.mjs";
import { releaseService } from "./services.mjs";
import { deployLive, uploadVersion } from "./wrangler-commands.mjs";
import { readWranglerTarget } from "./wrangler-config.mjs";

/**
 * @typedef {import("./cloudflare-api.mjs").CloudflareApi} CloudflareApi
 * @typedef {import("./manifest.mjs").ServiceRelease} ServiceRelease
 * @typedef {import("./wrangler-config.mjs").WranglerTarget} WranglerTarget
 * @typedef {import("./wrangler-config.mjs").WorkerDescription} WorkerDescription
 */

/**
 * @param {string} root the repo root
 * @param {{ id: string, target: WranglerTarget, cloudflare: CloudflareApi, vars?: Record<string, string> }} options
 * @returns {Promise<ServiceRelease>}
 */
export async function stageService(root, { id, target, cloudflare, vars = {} }) {
  const { tier } = releaseService(id);
  const manifest = requireStagedManifest(root);
  const worker = readWranglerTarget(root, target);

  const previousVersionId = await cloudflare.liveVersion(worker.workerName);
  const deployedMigrationTag =
    worker.migrationTag === null ? null : ((await cloudflare.migrationTags()).get(worker.workerName) ?? null);
  const directReason = liveDeployReason({ worker, workerExists: previousVersionId !== null, deployedMigrationTag });

  const options = { vars, message: releaseMessage(manifest.releaseId) };
  if (directReason) console.log(`[release] ${id} deploys live now, not at the flip: ${directReason}.`);
  const versionId = directReason ? await deployLive(root, target, options) : await uploadVersion(root, target, options);

  /** @type {ServiceRelease} */
  const service = {
    id,
    tier,
    worker: worker.workerName,
    mode: directReason ? "direct" : "staged",
    directReason,
    versionId,
    previousVersionId,
    rollback: !worker.hasContainers,
    target,
  };
  // Read again: the upload ran for minutes, and the file is the record.
  writeManifestFile(root, withService(requireStagedManifest(root), service));
  console.log(
    `[release] ${id}: ${service.mode} version ${versionId} of ${worker.workerName} (live before: ${previousVersionId ?? "none"}).`,
  );
  return service;
}

/**
 * Why a Worker must deploy live instead of as a staged version, or null.
 * Cloudflare applies a container image and a Durable Object migration only
 * on `wrangler deploy`, and a version can be uploaded only to a Worker that
 * exists.
 *
 * @param {{ worker: WorkerDescription, workerExists: boolean, deployedMigrationTag: string | null }} facts
 * @returns {string | null}
 */
export function liveDeployReason({ worker, workerExists, deployedMigrationTag }) {
  if (worker.hasContainers) return "it runs containers, and only wrangler deploy rolls out a container image";
  if (!workerExists) return "the Worker does not exist yet";
  if (worker.migrationTag !== null && worker.migrationTag !== deployedMigrationTag) {
    return `its Durable Object migration ${deployedMigrationTag ?? "(none)"} -> ${worker.migrationTag} needs wrangler deploy`;
  }
  return null;
}

/** The message that every version of a release carries in the Cloudflare dashboard. */
export function releaseMessage(releaseId) {
  return `Doxa release ${releaseId}`;
}
