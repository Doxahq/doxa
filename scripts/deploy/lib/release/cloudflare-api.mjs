// The read-only Cloudflare API calls of a release: which version of a Worker
// serves traffic, the variables of a version, and the Durable Object
// migration tag of each Worker. Wrangler has no command that prints the
// migration tag, so a release reads the API directly. Every write goes
// through Wrangler (./wrangler-commands.mjs).

import { spawnSync } from "node:child_process";
import path from "node:path";

const API_BASE_URL = "https://api.cloudflare.com/client/v4";

/** A workspace package that has Wrangler, to run `wrangler auth token`. */
const WRANGLER_PACKAGE = "apps/api-edge";

/**
 * @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchLike
 *
 * @typedef {object} CloudflareApi
 * @property {(worker: string) => Promise<string | null>} liveVersion
 *   the version that serves all traffic, or null when the Worker does not exist yet
 * @property {(worker: string, versionId: string) => Promise<Record<string, string>>} versionVars
 *   the plain-text variables of a version
 * @property {() => Promise<Map<string, string | null>>} migrationTags
 *   the deployed Durable Object migration tag of every Worker of the account
 */

/**
 * @param {{ accountId: string, token: string, fetchImpl?: FetchLike }} options
 * @returns {CloudflareApi}
 */
export function createCloudflareApi({ accountId, token, fetchImpl = fetch }) {
  /** @returns {Promise<any>} the result, or null for HTTP 404 */
  async function get(pathname) {
    const response = await fetchImpl(`${API_BASE_URL}/accounts/${accountId}${pathname}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 404) return null;
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success !== true) {
      throw new Error(`Cloudflare API GET ${pathname} failed with HTTP ${response.status}: ${describeErrors(body)}`);
    }
    return body.result;
  }

  /** @type {Promise<Map<string, string | null>> | undefined} */
  let migrationTags;

  return {
    async liveVersion(worker) {
      const result = await get(`/workers/scripts/${encodeURIComponent(worker)}/deployments`);
      return result ? liveVersionOf(worker, result.deployments ?? []) : null;
    },

    async versionVars(worker, versionId) {
      const result = await get(`/workers/scripts/${encodeURIComponent(worker)}/versions/${encodeURIComponent(versionId)}`);
      if (!result) throw new Error(`Worker ${worker} has no version ${versionId}.`);
      return plainTextVars(result.resources?.bindings ?? []);
    },

    migrationTags() {
      // One list call answers for every Worker of the release.
      migrationTags ??= get("/workers/scripts").then(
        (scripts) => new Map((scripts ?? []).map((script) => [script.id, script.migration_tag ?? null])),
      );
      return migrationTags;
    },
  };
}

/**
 * The version that serves all traffic. A release replaces one version with
 * another, so it refuses a Worker in a gradual deployment (two versions).
 *
 * @param {string} worker
 * @param {Array<{ versions?: Array<{ version_id: string, percentage: number }> }>} deployments newest first
 * @returns {string | null}
 */
export function liveVersionOf(worker, deployments) {
  const latest = deployments[0];
  if (!latest) return null;
  const versions = latest.versions ?? [];
  if (versions.length !== 1 || versions[0].percentage !== 100) {
    const split = versions.map((version) => `${version.version_id}@${version.percentage}%`).join(", ");
    throw new Error(`${worker} is in a gradual deployment (${split}). Finish it with wrangler versions deploy, then release again.`);
  }
  return versions[0].version_id;
}

/**
 * @param {Array<{ type: string, name: string, text?: string }>} bindings
 * @returns {Record<string, string>}
 */
export function plainTextVars(bindings) {
  return Object.fromEntries(
    bindings
      .filter((binding) => binding.type === "plain_text" && typeof binding.text === "string")
      .map((binding) => [binding.name, binding.text]),
  );
}

/**
 * The account from CLOUDFLARE_ACCOUNT_ID, and the token that Wrangler uses:
 * CLOUDFLARE_API_TOKEN in CI, or the token of a local `wrangler login`.
 *
 * @param {string} root the repo root
 * @param {NodeJS.ProcessEnv} env
 * @returns {CloudflareApi}
 */
export function cloudflareApiFromEnvironment(root, env = process.env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!accountId) {
    throw new Error("A release reads the Cloudflare API: set CLOUDFLARE_ACCOUNT_ID to the production account.");
  }
  return createCloudflareApi({ accountId, token: env.CLOUDFLARE_API_TOKEN?.trim() || wranglerToken(root) });
}

function wranglerToken(root) {
  const result = spawnSync("pnpm", ["exec", "wrangler", "auth", "token", "--json"], {
    cwd: path.join(root, WRANGLER_PACKAGE),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`No Cloudflare token: set CLOUDFLARE_API_TOKEN or run wrangler login.\n${result.stderr ?? ""}`);
  }
  const token = JSON.parse(result.stdout).token;
  if (typeof token !== "string" || token === "") throw new Error("wrangler auth token returned no token.");
  return token;
}

function describeErrors(body) {
  const errors = body?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return "no error details";
  return errors.map((error) => `${error.code}: ${error.message}`).join("; ");
}
