import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const apiConfig = JSON.parse(readFileSync(path.join(ROOT, "apps/api/wrangler.json"), "utf8"));
const apiPackage = JSON.parse(readFileSync(path.join(ROOT, "apps/api/package.json"), "utf8"));

// doxa-api-production is the edge Worker. A production deploy of apps/api
// would replace it with the old full API Worker, so it must always stop.
test("a production deploy of apps/api runs the refusing build command", () => {
  assert.equal(apiConfig.env.production.build?.command, "node ../../scripts/deploy/refuse-api-worker-deploy.mjs");
  assert.equal(apiPackage.scripts.deploy, "node ../../scripts/deploy/refuse-api-worker-deploy.mjs");
});

test("local development does not run the refusing command", () => {
  assert.equal(apiConfig.build, undefined);
});

test("the guard exits with an error and says what to run instead", () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/deploy/refuse-api-worker-deploy.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Do not deploy apps\/api as a Worker/);
  assert.match(result.stderr, /pnpm deploy:api/);
});
