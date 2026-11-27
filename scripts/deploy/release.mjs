#!/usr/bin/env node
// A production release in phases, so that every service switches to its new
// version within seconds of the others (the flip), not over a 10-minute deploy.
//
//   node scripts/deploy/release.mjs init                  start a release: contract check, new manifest
//   node scripts/deploy/release.mjs stage <service>       upload one service's version, with no traffic
//   node scripts/deploy/release.mjs flip                  serve every staged version, one tier at a time
//   node scripts/deploy/release.mjs records               store the live release again, if the flip could not
//   node scripts/deploy/release.mjs verify                smoke-check production; roll back on a failure
//   node scripts/deploy/release.mjs watch [--minutes N]   keep checking for N minutes (15), then stop the old API color
//   node scripts/deploy/release.mjs rollback [--release <id>]   serve the versions from before the release again
//   node scripts/deploy/release.mjs status                print the manifest of this deploy
//
// The docs-rendering and api steps stage their Workers themselves
// (deploy-renderer.mjs --stage, deploy-api.mjs --stage). scripts/deploy/deploy-production.mjs
// runs all of it in order. The manifest of the deploy is .artifacts/release/manifest.json;
// a live release is also in R2 (scripts/deploy/lib/release/store.mjs).
//
// Options:
//   --allow-contract-break   init: release although the contract check fails
//                            (or DOXA_ALLOW_CONTRACT_BREAK=true)
//   --minutes N              watch: hold time (or DOXA_RELEASE_HOLD_MINUTES)
//   --release <id>           rollback: a release from the store, not this deploy's
//
// DOXA_RELEASE_SMOKE_URLS adds https URLs to the smoke checks, for example a docs page.

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { imageTagFor } from "./lib/api-deploy.mjs";
import { EXCLUDE_WRANGLER_CONFIGS, assertIdsFilled } from "./lib/production-ids.mjs";
import { cloudflareApiFromEnvironment } from "./lib/release/cloudflare-api.mjs";
import { currentContract, findContractBreaks } from "./lib/release/contract.mjs";
import {
  createManifest,
  flipTiers,
  markLive,
  markRolledBack,
  readManifestFile,
  requireStagedManifest,
  rollbackGaps,
  rollbackTiers,
  writeManifestFile,
} from "./lib/release/manifest.mjs";
import { releaseService } from "./lib/release/services.mjs";
import { parseSmokeUrls, productionSmokeChecks, runSmokeChecks } from "./lib/release/smoke.mjs";
import { releaseMessage, stageService } from "./lib/release/stage.mjs";
import { createReleaseStore } from "./lib/release/store.mjs";
import { deployTriggers, restoreVersion, serveVersion } from "./lib/release/wrangler-commands.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_HOLD_MINUTES = 15;
const WATCH_INTERVAL_MS = 60_000;

/** @typedef {import("./lib/release/manifest.mjs").ReleaseManifest} ReleaseManifest */

const COMMANDS = { init, stage, flip, records, verify, watch, rollback, status };

const [commandName, ...args] = process.argv.slice(2);
const command = COMMANDS[commandName];
if (!command) fail(`Usage: node scripts/deploy/release.mjs ${Object.keys(COMMANDS).join("|")} [options]`);
try {
  await command(parseOptions(args));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function init(options) {
  const releaseId = currentReleaseId();
  const contract = currentContract();
  const live = createReleaseStore(ROOT).readLive();
  if (live) {
    const breaks = findContractBreaks(live.contract, contract);
    if (breaks.length > 0) {
      const list = breaks.map((line) => `  - ${line}`).join("\n");
      if (!options.allowContractBreak) {
        fail(
          `This release removes what the live release ${live.releaseId} calls:\n${list}\n` +
            "Old callers call new code for a few seconds during the flip. Keep the old method for one release, " +
            "or pass --allow-contract-break if these calls can fail.",
        );
      }
      warn(`The contract check failed, and --allow-contract-break lets the release continue:\n${list}`);
    } else {
      log(`Contract check passed against the live release ${live.releaseId}.`);
    }
  } else {
    log("No live release in the store: there is no contract to check against yet.");
  }
  writeManifestFile(ROOT, createManifest({ releaseId, commit: git(["rev-parse", "HEAD"]), contract }));
  log(`Release ${releaseId} started.`);
}

async function stage(options) {
  const [id] = options.positional;
  if (!id) fail("Usage: node scripts/deploy/release.mjs stage <service>");
  const service = releaseService(id);
  if (!service.target) fail(`${id} is staged by its own step (docs-rendering or api), not by stage.`);
  assertIdsFilled(ROOT);
  if (service.build) runCommand(service.build);
  await stageService(ROOT, { id, target: service.target, cloudflare: cloudflareApiFromEnvironment(ROOT) });
}

async function flip() {
  let manifest = requireStagedManifest(ROOT);
  const store = createReleaseStore(ROOT);
  const previousLive = store.readLive();
  const message = releaseMessage(manifest.releaseId);
  const tiers = flipTiers(manifest);
  if (tiers.length === 0) fail(`Release ${manifest.releaseId} has no staged service.`);

  const startedAt = Date.now();
  for (const [index, tier] of tiers.entries()) {
    log(`Flip tier ${index + 1}/${tiers.length}: ${tier.map((service) => service.id).join(", ")}.`);
    const failures = await settle(tier, (service) => serveVersion(ROOT, service.target, { versionId: service.versionId, message }));
    if (failures.length > 0) await abort(manifest, `The flip failed:\n${failures.join("\n")}`);
  }
  log(`Every staged version serves traffic (${seconds(startedAt)}).`);

  // Routes, crons, queue consumers and Workflows of the new configs.
  const staged = tiers.flat();
  const triggerFailures = await settle(staged, (service) => deployTriggers(ROOT, service.target));
  if (triggerFailures.length > 0) await abort(manifest, `The triggers of the new configs failed:\n${triggerFailures.join("\n")}`);

  // The local file first: from here on, verify, watch and rollback act on a live release.
  manifest = markLive(manifest, { previousReleaseId: previousLive?.releaseId ?? null });
  writeManifestFile(ROOT, manifest);
  log(`Release ${manifest.releaseId} is live.`);

  await records();
}

/** Names the live release in the store, and writes the renderer release record it brings. */
async function records() {
  const manifest = requireLiveManifest();
  const store = createReleaseStore(ROOT);
  const failures = [];
  try {
    store.publishLive(manifest);
  } catch (error) {
    failures.push(`The store does not name the release live: ${error.message}`);
  }
  if (manifest.renderer) {
    try {
      store.writeRendererRecord(manifest.renderer.recordAfter);
    } catch (error) {
      failures.push(`The renderer release record is not written, so the next renderer deploy plans the wrong previous build: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    fail(`${failures.join("\n")}\nProduction serves the release. Write the records again with: node scripts/deploy/release.mjs records`);
  }
  log(`The store names release ${manifest.releaseId} live.`);
}

async function verify() {
  const manifest = requireLiveManifest();
  const failures = await runSmokeChecks(smokeChecksFor(manifest));
  if (failures.length > 0) await abort(manifest, `The smoke checks failed:\n${failures.join("\n")}`);
  log("Smoke checks passed.");
}

async function watch(options) {
  const manifest = requireLiveManifest();
  const minutes = options.minutes ?? holdMinutesFromEnvironment();
  const until = Date.now() + minutes * 60_000;
  log(`Watching release ${manifest.releaseId} for ${minutes} minute(s). A failed check rolls it back.`);
  while (Date.now() < until) {
    await sleep(Math.min(WATCH_INTERVAL_MS, Math.max(0, until - Date.now())));
    const failures = await runSmokeChecks(smokeChecksFor(manifest), { attempts: 3 });
    if (failures.length > 0) await abort(manifest, `A smoke check failed while watching:\n${failures.join("\n")}`);
  }
  if (manifest.origin) {
    log(`Stopping the old API color ${manifest.origin.previousColor}. From now on, a rollback starts it again first.`);
    runCommand([process.execPath, "scripts/deploy/deploy-api-ecs.mjs", "--retire", manifest.origin.previousColor]);
  }
  log(`Release ${manifest.releaseId} passed the watch.`);
}

async function rollback(options) {
  const store = createReleaseStore(ROOT);
  const local = readManifestFile(ROOT);
  const manifest = options.release
    ? store.read(options.release)
    : local && local.state !== "rolled-back"
      ? local
      : store.readLive();
  if (!manifest) fail(options.release ? `The store has no release ${options.release}.` : "There is no release to roll back.");
  // A release that a newer one replaced is not what production serves: roll back the newer one.
  if (options.release && store.readLive()?.releaseId !== options.release) {
    fail(`Release ${options.release} is not the live release. Roll back the live release, without --release.`);
  }
  const failures = await rollBack(manifest, store);
  if (failures.length > 0) fail(`The rollback is incomplete:\n${failures.join("\n")}`);
}

async function status() {
  const manifest = readManifestFile(ROOT);
  if (!manifest) {
    log("No release in this deploy.");
    return;
  }
  log(`Release ${manifest.releaseId} (${manifest.state}), commit ${manifest.commit}.`);
  for (const service of Object.values(manifest.services).sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id))) {
    log(`  tier ${service.tier}  ${service.id.padEnd(22)} ${service.mode.padEnd(7)} ${service.versionId} (before: ${service.previousVersionId ?? "none"})`);
  }
  if (manifest.origin) {
    const { color, revision, previousColor, previousRevision } = manifest.origin;
    log(`  origin  ${previousColor} ${previousRevision} -> ${color} ${revision}`);
  }
}

/**
 * Rolls the release back, reports why, and exits with an error. A failed
 * step of a release leaves production as it was before the release.
 *
 * @param {ReleaseManifest} manifest
 * @param {string} reason
 */
async function abort(manifest, reason) {
  console.error(`[release] ${reason}`);
  console.error(`[release] Rolling release ${manifest.releaseId} back.`);
  const failures = await rollBack(manifest, createReleaseStore(ROOT));
  fail(failures.length > 0 ? `The rollback is incomplete:\n${failures.join("\n")}` : `Release ${manifest.releaseId} is rolled back.`);
}

/**
 * Serves what served before the release: the old API color first (started
 * again if the watch stopped it), then the previous version of every
 * service, callers first. Returns the steps that failed.
 *
 * @param {ReleaseManifest} manifest
 * @param {import("./lib/release/store.mjs").ReleaseStore} store
 * @returns {Promise<string[]>}
 */
async function rollBack(manifest, store) {
  const failures = [];
  const message = `Rollback of ${releaseMessage(manifest.releaseId)}`;
  const wasLive = manifest.state === "live";

  if (manifest.origin) {
    const { previousColor, previousRevision } = manifest.origin;
    log(`Making sure that ${previousColor} runs ${previousRevision}.`);
    const started = spawnSync(
      process.execPath,
      ["scripts/deploy/deploy-api-ecs.mjs", "--color", previousColor, "--revision", previousRevision],
      { cwd: ROOT, stdio: "inherit" },
    );
    if (started.status !== 0) failures.push(`The old API color ${previousColor} did not start: the edge stays on the new color.`);
  }

  const originReady = failures.length === 0;
  for (const tier of rollbackTiers(manifest)) {
    const restorable = tier.filter((service) => originReady || service.id !== "api-edge");
    failures.push(
      ...(await settle(restorable, (service) =>
        restoreVersion(ROOT, { worker: service.worker, versionId: service.previousVersionId, message }),
      )),
    );
  }
  for (const gap of rollbackGaps(manifest)) warn(`${gap.id} is not rolled back: ${gap.reason}.`);
  // Only when every Worker serves its old version again, the edge included, no traffic reaches the new color.
  const trafficRestored = failures.length === 0;

  if (wasLive) failures.push(...restoreRecords(manifest, store));
  if (readManifestFile(ROOT)?.releaseId === manifest.releaseId) writeManifestFile(ROOT, markRolledBack(manifest));

  if (manifest.origin && trafficRestored) {
    runCommand([process.execPath, "scripts/deploy/deploy-api-ecs.mjs", "--retire", manifest.origin.color]);
  }
  return failures;
}

/**
 * Writes back the renderer release record from before the release, and names
 * the previous release live. Returns the writes that failed.
 *
 * @param {ReleaseManifest} manifest
 * @param {import("./lib/release/store.mjs").ReleaseStore} store
 * @returns {string[]}
 */
function restoreRecords(manifest, store) {
  const failures = [];
  const attemptWrite = (label, write) => {
    try {
      write();
    } catch (error) {
      failures.push(`  - ${label}: ${error.message}`);
    }
  };
  if (manifest.renderer) {
    attemptWrite("renderer release record", () => store.writeRendererRecord(manifest.renderer.recordBefore));
  }
  // The flip may have failed to name the release live; then the store already names the previous one.
  attemptWrite("live release in the store", () => {
    if (store.readLive()?.releaseId !== manifest.releaseId) return;
    store.setLive(manifest.previousReleaseId ? store.read(manifest.previousReleaseId) : null);
  });
  return failures;
}

/**
 * Runs `action` for every service at the same time, and returns one line per failure.
 *
 * @template {{ id: string }} T
 * @param {T[]} services
 * @param {(service: T) => Promise<void>} action
 * @returns {Promise<string[]>}
 */
async function settle(services, action) {
  const results = await Promise.allSettled(services.map((service) => action(service)));
  return results.flatMap((result, index) =>
    result.status === "rejected" ? [`  - ${services[index].id}: ${result.reason?.message ?? result.reason}`] : [],
  );
}

function requireLiveManifest() {
  const manifest = readManifestFile(ROOT);
  if (manifest?.state !== "live") fail("No release of this deploy is live. Run the flip first.");
  return manifest;
}

/** @param {ReleaseManifest} manifest */
function smokeChecksFor(manifest) {
  return productionSmokeChecks({
    releaseId: manifest.releaseId,
    originInRelease: manifest.origin !== null,
    extraUrls: parseSmokeUrls(process.env.DOXA_RELEASE_SMOKE_URLS),
  });
}

/** The release ID of this tree: its commit, and a time stamp when it has changes. */
function currentReleaseId() {
  const dirty = git(["status", "--porcelain", "--", ".", ...EXCLUDE_WRANGLER_CONFIGS]).length > 0;
  if (dirty && process.env.DOXA_DEPLOY_ALLOW_DIRTY !== "1") {
    fail("The working tree has changes. Commit them, or pass --allow-dirty to deploy-production.mjs.");
  }
  return imageTagFor({ commit: git(["rev-parse", "--short=12", "HEAD"]), dirty });
}

function holdMinutesFromEnvironment() {
  const value = process.env.DOXA_RELEASE_HOLD_MINUTES?.trim();
  return value ? parseMinutes(value) : DEFAULT_HOLD_MINUTES;
}

function parseMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60) fail(`The hold time must be 0 to 60 minutes, not "${value}".`);
  return minutes;
}

function parseOptions(args) {
  const options = {
    positional: [],
    allowContractBreak: process.env.DOXA_ALLOW_CONTRACT_BREAK === "true",
    minutes: undefined,
    release: undefined,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--allow-contract-break") options.allowContractBreak = true;
    else if (arg === "--minutes") options.minutes = parseMinutes(args[++index]);
    else if (arg === "--release") {
      options.release = args[++index];
      if (!options.release) fail("--release needs a release ID.");
    } else if (arg.startsWith("--")) fail(`Unknown option "${arg}".`);
    else options.positional.push(arg);
  }
  return options;
}

function runCommand([command, ...commandArgs]) {
  log(`$ ${[command === process.execPath ? "node" : command, ...commandArgs].join(" ")}`);
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${commandArgs.join(" ")} failed with exit code ${result.status}.`);
}

function git(gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) fail(`git ${gitArgs.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function seconds(startedAt) {
  return `${Math.round((Date.now() - startedAt) / 1000)}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[release] ${message}`);
}

function warn(message) {
  console.warn(`[release] ${message}`);
}

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}
