// The release manifest: every service version of one release, the version
// it replaces, and the API origin colors. The stage steps fill it, the flip
// serves it, and a rollback deploys its previous versions again. The rules
// are pure here; the steps do the I/O (scripts/deploy/release.mjs).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isOriginColor } from "./origin-colors.mjs";

export const MANIFEST_VERSION = 1;

/** The manifest of the current deploy, relative to the repo root (git ignores .artifacts/). */
export const MANIFEST_FILE = ".artifacts/release/manifest.json";

const RELEASE_ID = /^[0-9a-f]{12}(?:-dirty-\d{8}-\d{6})?$/;
const STATES = new Set(["staged", "live", "rolled-back"]);
const MODES = new Set(["staged", "direct"]);

/**
 * @typedef {import("./wrangler-config.mjs").WranglerTarget} WranglerTarget
 * @typedef {import("./contract.mjs").ReleaseContract} ReleaseContract
 * @typedef {import("./origin-colors.mjs").OriginColor} OriginColor
 *
 * @typedef {object} ServiceRelease
 * @property {string} id the service, for example "web"
 * @property {number} tier the flip order: tier 1 first, callees before callers
 * @property {string} worker
 * @property {"staged" | "direct"} mode staged: uploaded without traffic until the flip.
 *   direct: deployed live before the flip (containers, a new Durable Object migration)
 * @property {string | null} directReason why the mode is direct
 * @property {string} versionId
 * @property {string | null} previousVersionId the version that served before, null for a new Worker
 * @property {boolean} rollback false when deploying the previous version cannot restore the service
 * @property {WranglerTarget} target the config, for `wrangler triggers deploy` after the flip
 *
 * @typedef {object} OriginRelease
 * @property {OriginColor} color the ECS service that runs this release
 * @property {string} revision its task definition revision
 * @property {OriginColor} previousColor the ECS service that the edge used before
 * @property {string} previousRevision
 *
 * @typedef {object} RendererRecordRelease
 * @property {string} bucket
 * @property {Record<string, unknown> | null} recordBefore the renderer release record before this release
 * @property {Record<string, unknown>} recordAfter the record that names this release's renderer build
 *
 * @typedef {object} ReleaseManifest
 * @property {1} version
 * @property {string} releaseId
 * @property {string} commit
 * @property {string} createdAt
 * @property {"staged" | "live" | "rolled-back"} state
 * @property {string | null} liveAt
 * @property {string | null} previousReleaseId the release that was live before this one
 * @property {ReleaseContract} contract
 * @property {Record<string, ServiceRelease>} services
 * @property {OriginRelease | null} origin
 * @property {RendererRecordRelease | null} renderer
 */

/**
 * @param {{ releaseId: string, commit: string, contract: ReleaseContract, now?: Date }} options
 * @returns {ReleaseManifest}
 */
export function createManifest({ releaseId, commit, contract, now = new Date() }) {
  if (!RELEASE_ID.test(releaseId)) throw new Error(`"${releaseId}" is not a release ID.`);
  return {
    version: MANIFEST_VERSION,
    releaseId,
    commit,
    createdAt: now.toISOString(),
    state: "staged",
    liveAt: null,
    previousReleaseId: null,
    contract,
    services: {},
    origin: null,
    renderer: null,
  };
}

/** @returns {ReleaseManifest} */
export function withService(manifest, /** @type {ServiceRelease} */ service) {
  assertStaged(manifest);
  return { ...manifest, services: { ...manifest.services, [service.id]: service } };
}

/** @returns {ReleaseManifest} */
export function withOrigin(manifest, /** @type {OriginRelease} */ origin) {
  assertStaged(manifest);
  return { ...manifest, origin };
}

/** @returns {ReleaseManifest} */
export function withRendererRecord(manifest, /** @type {RendererRecordRelease} */ renderer) {
  assertStaged(manifest);
  return { ...manifest, renderer };
}

/** @returns {ReleaseManifest} */
export function markLive(manifest, { previousReleaseId, now = new Date() }) {
  assertStaged(manifest);
  return { ...manifest, state: "live", liveAt: now.toISOString(), previousReleaseId };
}

/** @returns {ReleaseManifest} */
export function markRolledBack(manifest) {
  return { ...manifest, state: "rolled-back" };
}

/**
 * The staged services in flip order: one list per tier, lowest tier first.
 * The services of a tier flip together.
 *
 * @param {ReleaseManifest} manifest
 * @returns {ServiceRelease[][]}
 */
export function flipTiers(manifest) {
  return groupByTier(Object.values(manifest.services).filter((service) => service.mode === "staged"), "ascending");
}

/**
 * The services that a rollback deploys again, callers first: one list per
 * tier, highest tier first. A service without a previous version, or one
 * whose previous version cannot restore it, is left out (see `rollbackGaps`).
 *
 * @param {ReleaseManifest} manifest
 * @returns {ServiceRelease[][]}
 */
export function rollbackTiers(manifest) {
  return groupByTier(Object.values(manifest.services).filter(canRollBack), "descending");
}

/**
 * The services that a rollback cannot restore, with the reason.
 *
 * @param {ReleaseManifest} manifest
 * @returns {Array<{ id: string, reason: string }>}
 */
export function rollbackGaps(manifest) {
  return Object.values(manifest.services)
    .filter((service) => !canRollBack(service) && service.versionId !== service.previousVersionId)
    .map((service) => ({
      id: service.id,
      reason: service.previousVersionId === null ? "it is new in this release" : "a Worker version does not restore its container image",
    }));
}

function canRollBack(/** @type {ServiceRelease} */ service) {
  return service.rollback && service.previousVersionId !== null && service.previousVersionId !== service.versionId;
}

/**
 * @param {ServiceRelease[]} services
 * @param {"ascending" | "descending"} order
 */
function groupByTier(services, order) {
  const tiers = [...new Set(services.map((service) => service.tier))].sort((a, b) => (order === "ascending" ? a - b : b - a));
  return tiers.map((tier) =>
    services.filter((service) => service.tier === tier).sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function assertStaged(/** @type {ReleaseManifest} */ manifest) {
  if (manifest.state !== "staged") {
    throw new Error(`Release ${manifest.releaseId} is ${manifest.state}: start a new release with the release step.`);
  }
}

/**
 * Parses a stored manifest, and refuses one that a release cannot act on.
 *
 * @param {string} text
 * @param {string} source
 * @returns {ReleaseManifest}
 */
export function parseManifest(text, source = "the release manifest") {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON.`);
  }
  const problem = findManifestProblem(value);
  if (problem) throw new Error(`${source} is invalid: ${problem}.`);
  return value;
}

/** @returns {string | null} */
function findManifestProblem(value) {
  if (typeof value !== "object" || value === null) return "it is not an object";
  if (value.version !== MANIFEST_VERSION) return `version must be ${MANIFEST_VERSION}`;
  if (typeof value.releaseId !== "string" || !RELEASE_ID.test(value.releaseId)) return "releaseId is not a release ID";
  if (typeof value.commit !== "string" || value.commit === "") return "commit is missing";
  if (!STATES.has(value.state)) return `state "${value.state}" is unknown`;
  if (typeof value.services !== "object" || value.services === null) return "services is missing";
  for (const [id, service] of Object.entries(value.services)) {
    const problem = findServiceProblem(id, service);
    if (problem) return `service ${id}: ${problem}`;
  }
  if (value.origin !== null) {
    const { color, previousColor, revision, previousRevision } = value.origin ?? {};
    if (!isOriginColor(color) || !isOriginColor(previousColor)) return "origin colors must be blue or green";
    if (typeof revision !== "string" || typeof previousRevision !== "string") return "origin revisions are missing";
  }
  return null;
}

function findServiceProblem(id, service) {
  if (typeof service !== "object" || service === null || service.id !== id) return "the entry does not match its key";
  if (!Number.isInteger(service.tier) || service.tier < 1) return "tier must be a positive integer";
  if (!MODES.has(service.mode)) return `mode "${service.mode}" is unknown`;
  if (typeof service.worker !== "string" || typeof service.versionId !== "string") return "worker and versionId are required";
  if (service.previousVersionId !== null && typeof service.previousVersionId !== "string") return "previousVersionId must be a string or null";
  if (typeof service.rollback !== "boolean") return "rollback must be true or false";
  if (typeof service.target?.cwd !== "string" || !Array.isArray(service.target?.args)) return "target is missing";
  return null;
}

/**
 * The manifest of this deploy, or null when no release step ran.
 *
 * @param {string} root the repo root
 * @returns {ReleaseManifest | null}
 */
export function readManifestFile(root) {
  const file = path.join(root, MANIFEST_FILE);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return parseManifest(text, MANIFEST_FILE);
}

/**
 * @param {string} root
 * @param {ReleaseManifest} manifest
 */
export function writeManifestFile(root, manifest) {
  const file = path.join(root, MANIFEST_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The staged manifest that a stage step adds to. A stage step never starts a
 * release by itself: one deploy is one release, started by the release step.
 *
 * @param {string} root
 * @returns {ReleaseManifest}
 */
export function requireStagedManifest(root) {
  const manifest = readManifestFile(root);
  if (!manifest) {
    throw new Error(`No release is staged (${MANIFEST_FILE} is missing). Run the release step first: node scripts/deploy/deploy-production.mjs --step release.`);
  }
  assertStaged(manifest);
  return manifest;
}
