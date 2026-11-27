// The Wrangler commands of a release. Each one runs `pnpm exec wrangler` in
// the package of its Worker. Wrangler writes a machine-readable record of
// each upload and deploy to WRANGLER_OUTPUT_FILE_PATH; the version IDs come
// from there, not from the printed text.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

/** A workspace package that has Wrangler, for commands that name the Worker with --name. */
const WRANGLER_PACKAGE = "apps/api-edge";

/**
 * @typedef {import("./wrangler-config.mjs").WranglerTarget} WranglerTarget
 * @typedef {{ vars?: Record<string, string>, message: string }} UploadOptions
 */

/**
 * Uploads a version of the Worker without sending traffic to it.
 *
 * @param {string} root
 * @param {WranglerTarget} target
 * @param {UploadOptions} options
 * @returns {Promise<string>} the version ID
 */
export async function uploadVersion(root, target, { vars = {}, message }) {
  const entries = await runWrangler(root, {
    cwd: target.cwd,
    args: ["versions", "upload", ...target.args, "--message", message, ...varArgs(vars)],
    label: target.cwd,
  });
  return versionIdOf(entries, "version-upload");
}

/**
 * Deploys the Worker live, as `wrangler deploy` does: for a Worker that a
 * staged version cannot carry (containers, a new Durable Object migration).
 *
 * @param {string} root
 * @param {WranglerTarget} target
 * @param {UploadOptions} options
 * @returns {Promise<string>} the version ID
 */
export async function deployLive(root, target, { vars = {}, message }) {
  const entries = await runWrangler(root, {
    cwd: target.cwd,
    args: ["deploy", ...target.args, "--message", message, ...varArgs(vars)],
    label: target.cwd,
  });
  return versionIdOf(entries, "deploy");
}

/**
 * Sends all traffic of the Worker to one version. Like `wrangler deploy`,
 * it also syncs the settings that versions do not carry (logpush,
 * observability, tail consumers) from the Worker's config.
 *
 * @param {string} root
 * @param {WranglerTarget} target
 * @param {{ versionId: string, message: string }} options
 */
export async function serveVersion(root, target, { versionId, message }) {
  await runWrangler(root, {
    cwd: target.cwd,
    args: ["versions", "deploy", `${versionId}@100%`, ...target.args, "--message", message, "--yes"],
    label: target.cwd,
  });
}

/**
 * Sends all traffic of a Worker back to an earlier version. It names the
 * Worker with --name and an empty config, so it needs no built config of the
 * release and leaves the Worker's settings as they are.
 *
 * @param {string} root
 * @param {{ worker: string, versionId: string, message: string }} options
 */
export async function restoreVersion(root, { worker, versionId, message }) {
  const configDir = mkdtempSync(path.join(tmpdir(), "doxa-release-config-"));
  const emptyConfig = path.join(configDir, "wrangler.json");
  writeFileSync(emptyConfig, "{}\n");
  try {
    await runWrangler(root, {
      cwd: WRANGLER_PACKAGE,
      args: ["versions", "deploy", `${versionId}@100%`, "--config", emptyConfig, "--name", worker, "--message", message, "--yes"],
      label: worker,
    });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

/**
 * Applies the routes, custom domains, crons, queue consumers and Workflows
 * of the config. A version upload leaves them out; `wrangler deploy` runs
 * the same step after its upload.
 *
 * @param {string} root
 * @param {WranglerTarget} target
 */
export async function deployTriggers(root, target) {
  await runWrangler(root, { cwd: target.cwd, args: ["triggers", "deploy", ...target.args], label: target.cwd });
}

/**
 * The records of a Wrangler output file: one JSON object per line.
 *
 * @param {string} text
 * @returns {Array<Record<string, unknown>>}
 */
export function parseOutputEntries(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * @param {Array<Record<string, unknown>>} entries
 * @param {"version-upload" | "deploy"} type
 */
export function versionIdOf(entries, type) {
  const versionId = entries.findLast((entry) => entry.type === type)?.version_id;
  if (typeof versionId !== "string" || versionId === "") {
    throw new Error(`Wrangler reported no version ID for the ${type}.`);
  }
  return versionId;
}

/** @param {Record<string, string>} vars */
function varArgs(vars) {
  return Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`]);
}

/**
 * Runs one Wrangler command, with each output line prefixed by its label, so
 * commands that run at the same time stay readable. Rejects when it fails.
 *
 * @param {string} root
 * @param {{ cwd: string, args: string[], label: string }} command
 * @returns {Promise<Array<Record<string, unknown>>>} the records of the output file
 */
async function runWrangler(root, { cwd, args, label }) {
  const outputDir = mkdtempSync(path.join(tmpdir(), "doxa-release-"));
  const outputFile = path.join(outputDir, "wrangler-output.ndjson");
  console.log(`[release] ${cwd}$ wrangler ${args.join(" ")}`);
  try {
    const child = spawn("pnpm", ["exec", "wrangler", ...args], {
      cwd: path.join(root, cwd),
      env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outputFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const prefix = `[${label}] `;
    createInterface({ input: child.stdout }).on("line", (line) => console.log(prefix + line));
    createInterface({ input: child.stderr }).on("line", (line) => console.error(prefix + line));
    const status = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (status !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(" ")} failed in ${cwd} with exit code ${status}.`);
    return parseOutputEntries(readFileIfPresent(outputFile));
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

function readFileIfPresent(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}
