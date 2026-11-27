#!/usr/bin/env node
// Deploys the API: the Node origin on the idle ECS color (blue/green), then
// the thin doxa-api Worker (apps/api-edge) that names that color and serves
// api.doxa.so.
//
//   node scripts/deploy/deploy-api.mjs --stage                      release step: start the idle color, stage the edge (no traffic)
//   node scripts/deploy/deploy-api.mjs                              deploy now: start the idle color, deploy the edge, stop the old color
//   node scripts/deploy/deploy-api.mjs --renderer-release <id>      also set DOXA_RENDERER_RELEASE_ID
//   node scripts/deploy/deploy-api.mjs --image <repository>:<tag>   deploy an image that is already in ECR
//   node scripts/deploy/deploy-api.mjs --build-only                 build and push the image, deploy nothing
//
// With --stage, the flip of the release (scripts/deploy/release.mjs flip) sends the
// traffic to the new color, together with the other Workers.
//
// The image comes from --image, else DOXA_API_IMAGE, else a linux/arm64 build
// of this commit, tagged with its 12-character SHA. A tag that ECR already
// has is reused, because ECR tags are immutable.
//
// The renderer release comes from --renderer-release, else from
// apps/api/dist/wrangler.production.json (the renderer release writes it).
// Without either, the origin keeps its current value.
//
// A tree with changes builds only with --allow-dirty (or
// DOXA_DEPLOY_ALLOW_DIRTY=1, which `deploy-production.mjs --allow-dirty` sets).
// It uses the AWS CLI, Docker, Wrangler and the Cloudflare API (CLOUDFLARE_ACCOUNT_ID)
// with the credentials of the environment.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  EDGE_TARGET,
  RENDERER_RELEASE_CONFIG,
  assertRendererRelease,
  edgeVars,
  imageBuildArgs,
  imageTagFor,
  originStartArgs,
  rendererReleaseOf,
} from "./lib/api-deploy.mjs";
import { assertPinnedImage } from "./lib/ecs-task-definition.mjs";
import { EXCLUDE_WRANGLER_CONFIGS, assertIdsFilled } from "./lib/production-ids.mjs";
import { cloudflareApiFromEnvironment } from "./lib/release/cloudflare-api.mjs";
import { requireStagedManifest, withOrigin, writeManifestFile } from "./lib/release/manifest.mjs";
import { liveColorOf, otherColor } from "./lib/release/origin-colors.mjs";
import { releaseMessage, stageService } from "./lib/release/stage.mjs";
import { deployLive } from "./lib/release/wrangler-commands.mjs";
import { readWranglerTarget } from "./lib/release/wrangler-config.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const REGION = process.env.AWS_REGION ?? "us-east-1";
const REPOSITORY_NAME = "doxa-api";

const options = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
/** @type {string | undefined} */
let treeTag;

const { image, build } = resolveImage();
if (build) {
  loginToRegistry(image);
  run("docker", imageBuildArgs(image), "image");
}

if (options.buildOnly) {
  if (!build) log(`ECR already has ${image}.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `image=${image}\n`);
  log(`Image: ${image}`);
  process.exit(0);
}

// The edge config must hold the real VPC Service IDs before the edge deploys.
attempt(() => assertIdsFilled(ROOT));
const manifest = options.stage ? attempt(() => requireStagedManifest(ROOT)) : null;
const releaseId = manifest?.releaseId ?? currentTreeTag();
const cloudflare = attempt(() => cloudflareApiFromEnvironment(ROOT));
const rendererRelease = resolveRendererRelease();
log(
  rendererRelease
    ? `Renderer release: ${rendererRelease}.`
    : `No renderer release given and no ${RENDERER_RELEASE_CONFIG}: the origin keeps its current value.`,
);

const liveColor = await readLiveColor();
const color = otherColor(liveColor);
log(`The edge serves ${liveColor}. Release ${releaseId} starts on ${color}.`);
const origin = startOrigin(color);

if (manifest) {
  await stageService(ROOT, { id: "api-edge", target: EDGE_TARGET, cloudflare, vars: edgeVars({ color, releaseId }) });
  writeManifestFile(
    ROOT,
    withOrigin(requireStagedManifest(ROOT), {
      color,
      revision: origin.revision,
      previousColor: liveColor,
      previousRevision: origin.otherRevision,
    }),
  );
  log(`Staged: ${color} runs ${origin.revision}. The flip sends the traffic to it.`);
} else {
  await deployLive(ROOT, EDGE_TARGET, { vars: edgeVars({ color, releaseId }), message: releaseMessage(releaseId) }).catch((error) => {
    fail(`${error.message}\n${color} runs the new image but gets no traffic. Deploy the edge again, or stop ${color}: node scripts/deploy/deploy-api-ecs.mjs --retire ${color}`);
  });
  run(process.execPath, ["scripts/deploy/deploy-api-ecs.mjs", "--retire", liveColor], "retire");
  log(`Roll back with: node scripts/deploy/deploy-api-ecs.mjs --color ${liveColor} --revision ${origin.otherRevision}`);
  log("then: pnpm --filter @doxahq/api-edge exec wrangler rollback --env production");
}
log(`Done in ${Math.round((Date.now() - startedAt) / 1000)}s.`);

/** The color that the live edge version names. */
async function readLiveColor() {
  const edgeWorker = readWranglerTarget(ROOT, EDGE_TARGET).workerName;
  const versionId = await cloudflare.liveVersion(edgeWorker);
  if (!versionId) fail(`${edgeWorker} does not exist yet. Deploy it once with wrangler deploy.`);
  return liveColorOf(await cloudflare.versionVars(edgeWorker, versionId));
}

/** Starts the image on a color and waits until it is healthy. */
function startOrigin(targetColor) {
  const outputDir = mkdtempSync(path.join(tmpdir(), "doxa-api-origin-"));
  const outputFile = path.join(outputDir, "origin.json");
  try {
    run(process.execPath, originStartArgs({ image, color: targetColor, releaseId, rendererRelease, outputFile }), "origin");
    return JSON.parse(readFileSync(outputFile, "utf8"));
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

function resolveImage() {
  const given = options.image ?? process.env.DOXA_API_IMAGE;
  if (given) {
    attempt(() => assertPinnedImage(given));
    return { image: given, build: false };
  }
  const tag = currentTreeTag();
  const repository = process.env.DOXA_API_ECR_REPOSITORY_URL || repositoryUrl();
  const exists = spawnSync("aws", ["ecr", "describe-images", "--repository-name", REPOSITORY_NAME, "--image-ids", `imageTag=${tag}`, "--region", REGION], {
    stdio: "ignore",
  }).status === 0;
  return { image: `${repository}:${tag}`, build: !exists };
}

/** The image tag and release ID of this tree. Computed once, so both use the same time stamp. */
function currentTreeTag() {
  if (treeTag) return treeTag;
  const commit = capture("git", ["rev-parse", "--short=12", "HEAD"]).trim();
  const dirty = capture("git", ["status", "--porcelain", "--", ".", ...EXCLUDE_WRANGLER_CONFIGS]).trim().length > 0;
  if (dirty && !options.allowDirty) {
    fail("The working tree has changes. Commit them, or pass --allow-dirty to build the files on disk.");
  }
  treeTag = attempt(() => imageTagFor({ commit, dirty }));
  return treeTag;
}

function repositoryUrl() {
  const output = capture("aws", ["ecr", "describe-repositories", "--repository-names", REPOSITORY_NAME, "--region", REGION, "--query", "repositories[0].repositoryUri", "--output", "text"]);
  return output.trim();
}

function loginToRegistry(target) {
  const registry = target.split("/")[0];
  const password = capture("aws", ["ecr", "get-login-password", "--region", REGION]);
  const result = spawnSync("docker", ["login", "--username", "AWS", "--password-stdin", registry], {
    input: password,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (result.status !== 0) fail(`docker login to ${registry} failed:\n${result.stderr ?? ""}`);
}

function resolveRendererRelease() {
  if (options.rendererRelease) return attempt(() => assertRendererRelease(options.rendererRelease));
  const configPath = path.join(ROOT, RENDERER_RELEASE_CONFIG);
  if (!existsSync(configPath)) return undefined;
  return attempt(() => rendererReleaseOf(JSON.parse(readFileSync(configPath, "utf8"))));
}

function run(command, args, name) {
  log(`── ${name}: ${[path.basename(command), ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) fail(`Cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`The ${name} step failed with exit code ${result.status}.`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) fail(`Cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.slice(0, 2).join(" ")} failed:\n${result.stderr ?? ""}`);
  return result.stdout;
}

function parseArgs(args) {
  const parsed = {
    image: undefined,
    rendererRelease: undefined,
    buildOnly: false,
    stage: false,
    allowDirty: process.env.DOXA_DEPLOY_ALLOW_DIRTY === "1",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--build-only") parsed.buildOnly = true;
    else if (arg === "--stage") parsed.stage = true;
    else if (arg === "--allow-dirty") parsed.allowDirty = true;
    else if (arg === "--image" || arg === "--renderer-release") {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail(`${arg} needs a value.`);
      if (arg === "--image") parsed.image = value;
      else parsed.rendererRelease = value;
    } else {
      fail(`Unknown argument "${arg}".`);
    }
  }
  if (parsed.buildOnly && (parsed.image || parsed.rendererRelease || parsed.stage)) {
    fail("--build-only builds this commit: it takes no --image, --renderer-release or --stage.");
  }
  return parsed;
}

/** Runs a check that throws, and exits with its message instead of a stack trace. */
function attempt(check) {
  try {
    return check();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function log(message) {
  console.log(`[deploy-api] ${message}`);
}

function fail(message) {
  console.error(`[deploy-api] ${message}`);
  process.exit(1);
}
