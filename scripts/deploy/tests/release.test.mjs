import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { EDGE_TARGET, edgeVars, originStartArgs } from "../lib/api-deploy.mjs";
import { parseTaskCount, scalableTargetId, startingTaskCount, taskCountParameterName } from "../lib/ecs-origin.mjs";
import { createCloudflareApi, liveVersionOf, plainTextVars } from "../lib/release/cloudflare-api.mjs";
import { currentContract, findContractBreaks } from "../lib/release/contract.mjs";
import {
  createManifest,
  flipTiers,
  markLive,
  parseManifest,
  rollbackGaps,
  rollbackTiers,
  withOrigin,
  withService,
} from "../lib/release/manifest.mjs";
import { colorResourceName, liveColorOf, otherColor } from "../lib/release/origin-colors.mjs";
import { RELEASE_SERVICES } from "../lib/release/services.mjs";
import { checkOnce, parseSmokeUrls, productionSmokeChecks, runSmokeChecks } from "../lib/release/smoke.mjs";
import { liveDeployReason } from "../lib/release/stage.mjs";
import { parseOutputEntries, versionIdOf } from "../lib/release/wrangler-commands.mjs";
import { describeWranglerConfig, parseConfigArgs, readWranglerTarget } from "../lib/release/wrangler-config.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const RELEASE_ID = "0123456789ab";

/** The source configs of the services that a build step stages. */
const BUILT_TARGETS = {
  "docs-renderer-shared": { cwd: "apps/docs-template", args: ["-c", "wrangler.renderer.shared.production.json"] },
  "docs-dispatcher": { cwd: "apps/docs-dispatcher", args: [] },
  "docs-prerenderer": { cwd: "apps/docs-prerenderer", args: [] },
  "api-edge": EDGE_TARGET,
};

function targetOf(id) {
  return RELEASE_SERVICES[id].target ?? BUILT_TARGETS[id];
}

function service(overrides) {
  return {
    tier: 1,
    worker: `doxa-${overrides.id}`,
    mode: "staged",
    directReason: null,
    versionId: `${overrides.id}-new`,
    previousVersionId: `${overrides.id}-old`,
    rollback: true,
    target: { cwd: `apps/${overrides.id}`, args: [] },
    ...overrides,
  };
}

function manifestWith(services) {
  return services.reduce(
    (manifest, entry) => withService(manifest, service(entry)),
    createManifest({ releaseId: RELEASE_ID, commit: "0123456789abcdef", contract: currentContract(), now: new Date(0) }),
  );
}

// --- Flip tiers -------------------------------------------------------------

test("every service has a config, and every config names its Worker", () => {
  for (const id of Object.keys(RELEASE_SERVICES)) {
    const target = targetOf(id);
    assert.ok(target, `${id} has no target`);
    assert.match(readWranglerTarget(ROOT, target).workerName, /^doxa-/, id);
  }
});

test("a service flips after every Worker of the release that it binds to", () => {
  const configs = Object.fromEntries(
    Object.keys(RELEASE_SERVICES).map((id) => {
      const target = targetOf(id);
      const { config, env } = parseConfigArgs(target.args);
      const raw = JSON.parse(readFileSync(path.join(ROOT, target.cwd, config ?? "wrangler.json"), "utf8"));
      const scoped = env ? raw.env[env] : raw;
      return [id, { worker: readWranglerTarget(ROOT, target).workerName, bindings: (scoped.services ?? raw.services ?? []).map((b) => b.service) }];
    }),
  );
  const serviceOfWorker = new Map(Object.entries(configs).map(([id, { worker }]) => [worker, id]));

  const late = [];
  for (const [caller, { bindings }] of Object.entries(configs)) {
    for (const worker of bindings) {
      const callee = serviceOfWorker.get(worker);
      if (callee && RELEASE_SERVICES[callee].tier > RELEASE_SERVICES[caller].tier) late.push(`${caller} -> ${callee}`);
    }
  }
  assert.deepEqual(late, []);
});

test("the API flips before the Workers that call its entrypoints, and the web app goes last", () => {
  const tier = (id) => RELEASE_SERVICES[id].tier;
  for (const caller of ["email-worker", "mcp", "agent-worker", "web"]) assert.ok(tier(caller) > tier("api-edge"), caller);
  assert.equal(Math.max(...Object.values(RELEASE_SERVICES).map((entry) => entry.tier)), tier("web"));
});

// --- Wrangler configs and output ---------------------------------------------

test("names a Worker the way Wrangler does for an environment", () => {
  const config = { name: "doxa-api", migrations: [{ tag: "v1" }, { tag: "v2" }], env: { production: {}, named: { name: "other" } } };

  assert.deepEqual(describeWranglerConfig(config, "production"), { workerName: "doxa-api-production", migrationTag: "v2", hasContainers: false });
  assert.equal(describeWranglerConfig(config, "named").workerName, "other");
  assert.equal(describeWranglerConfig(config, undefined).workerName, "doxa-api");
  assert.throws(() => describeWranglerConfig(config, "staging"), /no env.staging/);
  assert.equal(describeWranglerConfig({ name: "c", containers: [{ class_name: "X" }] }, undefined).hasContainers, true);
});

test("reads the config and environment from Wrangler arguments", () => {
  assert.deepEqual(parseConfigArgs(["--config", "a.json", "--env", "production"]), { config: "a.json", env: "production" });
  assert.deepEqual(parseConfigArgs(["-c=b.json", "-e", "x", "--minify"]), { config: "b.json", env: "x" });
  assert.throws(() => parseConfigArgs(["--env"]), /--env needs a value/);
});

test("takes the version ID from the last matching record of the output file", () => {
  const entries = parseOutputEntries(
    '{"type":"wrangler-session"}\n{"type":"version-upload","version_id":"v-1"}\n\n{"type":"deploy","version_id":"v-2"}\n',
  );

  assert.equal(versionIdOf(entries, "version-upload"), "v-1");
  assert.equal(versionIdOf(entries, "deploy"), "v-2");
  assert.throws(() => versionIdOf([], "deploy"), /no version ID/);
});

test("deploys live only what a staged version cannot carry", () => {
  const worker = { configFile: "x", workerName: "w", migrationTag: "v2", hasContainers: false };

  assert.equal(liveDeployReason({ worker, workerExists: true, deployedMigrationTag: "v2" }), null);
  assert.match(liveDeployReason({ worker, workerExists: true, deployedMigrationTag: "v1" }), /migration v1 -> v2/);
  assert.match(liveDeployReason({ worker, workerExists: false, deployedMigrationTag: null }), /does not exist/);
  assert.match(liveDeployReason({ worker: { ...worker, hasContainers: true }, workerExists: true, deployedMigrationTag: "v2" }), /containers/);
  assert.equal(liveDeployReason({ worker: { ...worker, migrationTag: null }, workerExists: true, deployedMigrationTag: null }), null);
});

// --- Cloudflare API ----------------------------------------------------------

test("reads the live version, and refuses a gradual deployment", () => {
  assert.equal(liveVersionOf("w", [{ versions: [{ version_id: "a", percentage: 100 }] }, { versions: [{ version_id: "old", percentage: 100 }] }]), "a");
  assert.equal(liveVersionOf("w", []), null);
  assert.throws(
    () => liveVersionOf("w", [{ versions: [{ version_id: "a", percentage: 90 }, { version_id: "b", percentage: 10 }] }]),
    /gradual deployment \(a@90%, b@10%\)/,
  );
  assert.deepEqual(plainTextVars([{ type: "plain_text", name: "A", text: "1" }, { type: "secret_text", name: "S" }]), { A: "1" });
});

test("calls the account's API with the token, and treats 404 as a missing Worker", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization });
    if (url.endsWith("/workers/scripts/new-worker/deployments")) return new Response("{}", { status: 404 });
    if (url.endsWith("/workers/scripts")) return Response.json({ success: true, result: [{ id: "a", migration_tag: "v1" }, { id: "b" }] });
    if (url.endsWith("/deployments")) return Response.json({ success: true, result: { deployments: [{ versions: [{ version_id: "live", percentage: 100 }] }] } });
    return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
  };
  const api = createCloudflareApi({ accountId: "acct", token: "tok", fetchImpl });

  assert.equal(await api.liveVersion("doxa-api-production"), "live");
  assert.equal(await api.liveVersion("new-worker"), null);
  assert.deepEqual([...(await api.migrationTags())], [["a", "v1"], ["b", null]]);
  await api.migrationTags();
  await assert.rejects(api.versionVars("w", "v"), /HTTP 403: 10000: Authentication error/);

  assert.equal(calls.filter((call) => call.url.endsWith("/workers/scripts")).length, 1, "the script list is read once");
  assert.ok(calls.every((call) => call.url.startsWith("https://api.cloudflare.com/client/v4/accounts/acct/") && call.authorization === "Bearer tok"));
});

// --- Manifest ----------------------------------------------------------------

test("flips staged services by tier, and leaves live-deployed ones out", () => {
  const manifest = manifestWith([
    { id: "web", tier: 5 },
    { id: "docs-resolver", tier: 1 },
    { id: "try-proxy", tier: 1 },
    { id: "agent-container", tier: 1, mode: "direct", rollback: false },
    { id: "api-edge", tier: 3 },
  ]);

  assert.deepEqual(
    flipTiers(manifest).map((tier) => tier.map((entry) => entry.id)),
    [["docs-resolver", "try-proxy"], ["api-edge"], ["web"]],
  );
});

test("rolls back callers first, and names what it cannot restore", () => {
  const manifest = manifestWith([
    { id: "docs-resolver", tier: 1 },
    { id: "api-edge", tier: 3 },
    { id: "web", tier: 5 },
    { id: "agent-container", tier: 1, mode: "direct", rollback: false },
    { id: "search-gateway", tier: 2, previousVersionId: null },
  ]);

  assert.deepEqual(
    rollbackTiers(manifest).map((tier) => tier.map((entry) => entry.id)),
    [["web"], ["api-edge"], ["docs-resolver"]],
  );
  assert.deepEqual(rollbackGaps(manifest), [
    { id: "agent-container", reason: "a Worker version does not restore its container image" },
    { id: "search-gateway", reason: "it is new in this release" },
  ]);
});

test("a live manifest takes no more services, and round-trips through JSON", () => {
  const staged = withOrigin(manifestWith([{ id: "api-edge", tier: 3 }]), {
    color: "green",
    revision: "arn:green:2",
    previousColor: "blue",
    previousRevision: "arn:blue:7",
  });
  const live = markLive(staged, { previousReleaseId: "aaaaaaaaaaaa", now: new Date(1000) });

  assert.deepEqual(parseManifest(JSON.stringify(live)), live);
  assert.equal(live.liveAt, "1970-01-01T00:00:01.000Z");
  assert.throws(() => withService(live, service({ id: "web" })), /is live: start a new release/);
});

test("refuses a manifest that a release cannot act on", () => {
  const valid = manifestWith([{ id: "web", tier: 5 }]);
  const broken = [
    [{ ...valid, version: 2 }, /version must be 1/],
    [{ ...valid, releaseId: "main" }, /releaseId/],
    [{ ...valid, state: "half" }, /state "half"/],
    [{ ...valid, services: { web: { ...valid.services.web, id: "api" } } }, /does not match its key/],
    [{ ...valid, services: { web: { ...valid.services.web, mode: "canary" } } }, /mode "canary"/],
    [{ ...valid, origin: { color: "red", previousColor: "blue", revision: "a", previousRevision: "b" } }, /blue or green/],
  ];
  for (const [value, problem] of broken) assert.throws(() => parseManifest(JSON.stringify(value)), problem);
  assert.throws(() => parseManifest("{"), /not valid JSON/);
  assert.throws(() => createManifest({ releaseId: "HEAD", commit: "x", contract: currentContract() }), /not a release ID/);
});

// --- Contract ----------------------------------------------------------------

test("the contract lists the API entrypoints and the bridge of this commit", () => {
  const contract = currentContract();

  assert.ok(contract.entrypoints.InternalApi.includes("addJobEvent"));
  assert.deepEqual(contract.bridgeCalls.GENERATION_QUEUE, ["send", "sendBatch"]);
  assert.deepEqual(findContractBreaks(contract, contract), []);
});

test("a removed method or binding breaks the contract, an added one does not", () => {
  const live = { entrypoints: { A: ["x", "y"], B: ["z"] }, bridgeCalls: { Q: ["send"] }, bridgeFetches: ["C", "D"] };
  const next = { entrypoints: { A: ["x", "w"], C: ["new"] }, bridgeCalls: { Q: ["send", "sendBatch"] }, bridgeFetches: ["C"] };

  assert.deepEqual(findContractBreaks(live, next), [
    "The API entrypoint A no longer has y.",
    "The API entrypoint B is removed.",
    "The edge bridge no longer fetches D.",
  ]);
  assert.deepEqual(findContractBreaks(next, { ...next, entrypoints: { ...next.entrypoints, D: ["more"] } }), []);
});

// --- Smoke checks ------------------------------------------------------------

test("checks the API release only when the release has an origin", () => {
  const withOriginChecks = productionSmokeChecks({ releaseId: RELEASE_ID, originInRelease: true, extraUrls: ["https://docs.doxa.so/"] });
  const withoutOrigin = productionSmokeChecks({ releaseId: RELEASE_ID, originInRelease: false });

  assert.equal(withOriginChecks[0].release, RELEASE_ID);
  assert.equal(withoutOrigin[0].release, undefined);
  assert.equal(withOriginChecks.at(-1).url, "https://docs.doxa.so/");
  assert.deepEqual(parseSmokeUrls(" https://a.example/x , ,https://b.example "), ["https://a.example/x", "https://b.example"]);
  assert.throws(() => parseSmokeUrls("http://insecure.example"), /must be an https URL/);
});

test("a smoke check passes only with status 200, the content type and the release", async () => {
  const check = { name: "api", url: "https://api.doxa.so/health/ready", contentType: "application/json", release: RELEASE_ID };
  const answer = (status, headers) => async () => new Response("{}", { status, headers });

  assert.equal(await checkOnce(check, answer(200, { "content-type": "application/json", "x-doxa-release": RELEASE_ID })), null);
  assert.match(await checkOnce(check, answer(503, {})), /HTTP 503/);
  assert.match(await checkOnce(check, answer(200, { "content-type": "text/html" })), /not application\/json/);
  assert.match(
    await checkOnce(check, answer(200, { "content-type": "application/json", "x-doxa-release": "aaaaaaaaaaaa" })),
    /release aaaaaaaaaaaa, not 0123456789ab/,
  );
  assert.match(await checkOnce(check, async () => Promise.reject(new Error("offline"))), /did not answer \(offline\)/);
});

test("retries a failed smoke check, and reports it after the last attempt", async () => {
  let calls = 0;
  const flaky = async () => (++calls < 3 ? new Response("", { status: 502 }) : new Response("ok"));
  const sleeps = [];
  const sleep = async (ms) => void sleeps.push(ms);

  assert.deepEqual(await runSmokeChecks([{ name: "web", url: "https://doxa.so/" }], { fetchImpl: flaky, attempts: 3, delayMs: 5, sleep }), []);
  assert.deepEqual(sleeps, [5, 5]);
  assert.deepEqual(
    await runSmokeChecks([{ name: "web", url: "https://doxa.so/" }], { fetchImpl: async () => new Response("", { status: 500 }), attempts: 2, delayMs: 0, sleep }),
    ["web: https://doxa.so/ answered HTTP 500"],
  );
});

// --- Origin colors and ECS ---------------------------------------------------

test("blue keeps the names from before blue/green, and an old edge means blue", () => {
  assert.equal(colorResourceName("doxa-api-production", "blue"), "doxa-api-production");
  assert.equal(colorResourceName("doxa-api-production", "green"), "doxa-api-production-green");
  assert.equal(otherColor("blue"), "green");
  assert.equal(liveColorOf({}), "blue");
  assert.equal(liveColorOf({ ORIGIN_COLOR: "green" }), "green");
  assert.throws(() => liveColorOf({ ORIGIN_COLOR: "red" }), /Expected blue or green/);
});

test("a color starts with the live task count, within the stack's bounds", () => {
  const count = parseTaskCount('{"min":1,"max":3}');

  assert.equal(startingTaskCount(count, 0), 1);
  assert.equal(startingTaskCount(count, 2), 2);
  assert.equal(startingTaskCount(count, 9), 3);
  assert.throws(() => parseTaskCount('{"min":0,"max":1}'), /1 <= N <= M/);
  assert.throws(() => parseTaskCount('{"min":2,"max":1}'), /1 <= N <= M/);
  assert.throws(() => parseTaskCount("x"), /not JSON/);
  assert.equal(taskCountParameterName("production"), "/doxa/api/production/deploy/task-count");
  assert.equal(scalableTargetId("c", "s"), "service/c/s");
});

test("the API stage starts the origin with the release and names its color on the edge", () => {
  assert.deepEqual(
    originStartArgs({ image: "r/doxa-api:abc", color: "green", releaseId: RELEASE_ID, rendererRelease: "r-1", outputFile: "/tmp/o.json" }),
    ["scripts/deploy/deploy-api-ecs.mjs", "--color", "green", "--image", "r/doxa-api:abc", "--env", `DOXA_RELEASE_ID=${RELEASE_ID}`, "--env", "DOXA_RENDERER_RELEASE_ID=r-1", "--output", "/tmp/o.json"],
  );
  assert.deepEqual(edgeVars({ color: "green", releaseId: RELEASE_ID }), { ORIGIN_COLOR: "green", DOXA_RELEASE_ID: RELEASE_ID });
});

// --- CLI ---------------------------------------------------------------------

test("the release CLI refuses unknown commands and options before any I/O", () => {
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, "scripts/deploy/release.mjs"), ...args], { encoding: "utf8", env: { PATH: "" } });

  assert.match(run([]).stderr, /Usage: node scripts\/deploy\/release.mjs init\|stage\|flip/);
  assert.match(run(["watch", "--minutes", "90"]).stderr, /0 to 60 minutes/);
  assert.match(run(["stage"]).stderr, /Usage: node scripts\/deploy\/release.mjs stage <service>/);
  assert.match(run(["stage", "nope"]).stderr, /Unknown release service "nope"/);
  assert.match(run(["stage", "api-edge"]).stderr, /staged by its own step/);
});
