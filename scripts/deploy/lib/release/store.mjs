// Where releases live between deploys: the renderer code bucket, which the
// deploy already owns (it holds the renderer packages and the renderer
// release record). The live manifest is the base of the next release's
// contract check and of a rollback from any machine.
//
//   deploy-releases/current.json      the manifest of the live release
//   deploy-releases/<releaseId>.json  every release that went live

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RENDERER_RELEASE_RECORD_KEY, isMissingObjectOutput } from "../renderer-release-record.mjs";
import { parseManifest } from "./manifest.mjs";

/** Its Wrangler config names the bucket, and its package has Wrangler. */
const BUCKET_OWNER = "apps/docs-dispatcher";
const BUCKET_BINDING = "RENDERER_CODE_BUCKET";

export const CURRENT_RELEASE_KEY = "deploy-releases/current.json";

/** @param {string} releaseId */
export function releaseKey(releaseId) {
  return `deploy-releases/${releaseId}.json`;
}

/**
 * @typedef {import("./manifest.mjs").ReleaseManifest} ReleaseManifest
 *
 * @typedef {object} ReleaseStore
 * @property {() => ReleaseManifest | null} readLive the manifest of the live release
 * @property {(releaseId: string) => ReleaseManifest | null} read
 * @property {(manifest: ReleaseManifest) => void} publishLive stores the manifest and makes it the live one
 * @property {(manifest: ReleaseManifest | null) => void} setLive names another release live, or none
 * @property {(record: Record<string, unknown> | null) => void} writeRendererRecord
 */

/**
 * @param {string} root the repo root
 * @returns {ReleaseStore}
 */
export function createReleaseStore(root) {
  const bucket = releaseBucket(root);
  const r2 = createR2Objects(root, bucket);
  const readManifest = (key) => {
    const text = r2.getText(key);
    return text === null ? null : parseManifest(text, `${bucket}/${key}`);
  };
  return {
    readLive: () => readManifest(CURRENT_RELEASE_KEY),
    read: (releaseId) => readManifest(releaseKey(releaseId)),
    publishLive(manifest) {
      r2.putJson(releaseKey(manifest.releaseId), manifest);
      r2.putJson(CURRENT_RELEASE_KEY, manifest);
    },
    setLive(manifest) {
      if (manifest) r2.putJson(CURRENT_RELEASE_KEY, manifest);
      else r2.remove(CURRENT_RELEASE_KEY);
    },
    writeRendererRecord(record) {
      if (record) r2.putJson(RENDERER_RELEASE_RECORD_KEY, record);
      else r2.remove(RENDERER_RELEASE_RECORD_KEY);
    },
  };
}

/** The renderer code bucket, as the dispatcher config names it. */
export function releaseBucket(root) {
  const config = JSON.parse(readFileSync(path.join(root, BUCKET_OWNER, "wrangler.json"), "utf8"));
  const bucket = config.r2_buckets?.find((item) => item?.binding === BUCKET_BINDING)?.bucket_name;
  if (typeof bucket !== "string" || bucket === "") throw new Error(`${BUCKET_OWNER}/wrangler.json has no ${BUCKET_BINDING}.`);
  return bucket;
}

function createR2Objects(root, bucket) {
  const run = (args) => {
    const result = spawnSync("pnpm", ["exec", "wrangler", "r2", "object", ...args, "--remote"], {
      cwd: path.join(root, BUCKET_OWNER),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    return { ok: result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
  };
  const fail = (action, key, output) => {
    throw new Error(`Could not ${action} ${bucket}/${key}:\n${output.trim()}`);
  };
  const withTempFile = (use) => {
    const dir = mkdtempSync(path.join(tmpdir(), "doxa-release-r2-"));
    try {
      return use(path.join(dir, "object.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  return {
    /** @returns {string | null} null when the object does not exist */
    getText(key) {
      return withTempFile((file) => {
        const { ok, output } = run(["get", `${bucket}/${key}`, "--file", file]);
        if (ok) return readFileSync(file, "utf8");
        if (isMissingObjectOutput(output)) return null;
        return fail("read", key, output);
      });
    },
    putJson(key, value) {
      withTempFile((file) => {
        writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
        const { ok, output } = run(["put", `${bucket}/${key}`, "--file", file, "--content-type", "application/json", "--force"]);
        if (!ok) fail("write", key, output);
      });
    },
    remove(key) {
      const { ok, output } = run(["delete", `${bucket}/${key}`]);
      if (!ok && !isMissingObjectOutput(output)) fail("delete", key, output);
    },
  };
}
