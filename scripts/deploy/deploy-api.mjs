#!/usr/bin/env node
// Deploys the API: the Node origin on ECS, then the thin doxa-api Worker
// (apps/api-edge) that serves api.doxa.so. The renderer release runs it as
// its last step, and `pnpm deploy:api` runs it by hand.
//
//   node scripts/deploy-api.mjs                              build or reuse the image, deploy both
//   node scripts/deploy-api.mjs --renderer-release <id>      also set DOXA_RENDERER_RELEASE_ID
//   node scripts/deploy-api.mjs --image <repository>:<tag>   deploy an image that is already in ECR
//   node scripts/deploy-api.mjs --build-only                 build and push the image, deploy nothing
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
// It uses the AWS CLI, Docker and Wrangler with the credentials of the environment.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  RENDERER_RELEASE_CONFIG,
  assertRendererRelease,
  deploySteps,
  imageTagFor,
  rendererReleaseOf,
} from "./lib/api-deploy.mjs";
import { assertPinnedImage } from "./lib/ecs-task-definition.mjs";
import { EXCLUDE_WRANGLER_CONFIGS, assertIdsFilled } from "./lib/production-ids.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const REGION = process.env.AWS_REGION ?? "us-east-1";
const REPOSITORY_NAME = "doxa-api";

const options = parseArgs(process.argv.slice(2));
const startedAt = Date.now();

const { image, build } = resolveImage();
if (build) loginToRegistry(image);

if (options.buildOnly) {
  // With build set, the first step builds and pushes the image.
  if (build) runStep(deploySteps({ image, build }).at(0));
  else log(`ECR already has ${image}.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `image=${image}\n`);
  log(`Image: ${image}`);
  process.exit(0);
}

// The edge config must hold the real VPC Service ID before the edge deploys.
attempt(() => assertIdsFilled(ROOT));
const rendererRelease = resolveRendererRelease();
log(
  rendererRelease
    ? `Renderer release: ${rendererRelease}.`
    : `No renderer release given and no ${RENDERER_RELEASE_CONFIG}: the origin keeps its current value.`,
);
for (const step of deploySteps({ image, build, rendererRelease })) runStep(step);

log(`Done in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
log("Roll the edge back with: pnpm --filter @doxahq/api-edge exec wrangler rollback --env production");
log("Roll the origin back with the command that deploy-api-ecs printed above.");

function resolveImage() {
  const given = options.image ?? process.env.DOXA_API_IMAGE;
  if (given) {
    attempt(() => assertPinnedImage(given));
    return { image: given, build: false };
  }

  const commit = capture("git", ["rev-parse", "--short=12", "HEAD"]).trim();
  const dirty = capture("git", ["status", "--porcelain", "--", ".", ...EXCLUDE_WRANGLER_CONFIGS]).trim().length > 0;
  if (dirty && !options.allowDirty) {
    fail("The working tree has changes. Commit them, or pass --allow-dirty to build the files on disk.");
  }
  const tag = attempt(() => imageTagFor({ commit, dirty }));
  const repository = process.env.DOXA_API_ECR_REPOSITORY_URL || repositoryUrl();
  const image = `${repository}:${tag}`;
  const exists = spawnSync("aws", ["ecr", "describe-images", "--repository-name", REPOSITORY_NAME, "--image-ids", `imageTag=${tag}`, "--region", REGION], {
    stdio: "ignore",
  }).status === 0;
  return { image, build: !exists };
}

function repositoryUrl() {
  const output = capture("aws", ["ecr", "describe-repositories", "--repository-names", REPOSITORY_NAME, "--region", REGION, "--query", "repositories[0].repositoryUri", "--output", "text"]);
  return output.trim();
}

function loginToRegistry(image) {
  const registry = image.split("/")[0];
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

function runStep(step) {
  log(`── ${step.name}: ${[path.basename(step.command), ...step.args].join(" ")}`);
  const result = spawnSync(step.command, step.args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) fail(`Cannot run ${step.command}: ${result.error.message}`);
  if (result.status !== 0) fail(`The ${step.name} step failed with exit code ${result.status}.`);
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
    allowDirty: process.env.DOXA_DEPLOY_ALLOW_DIRTY === "1",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--build-only") parsed.buildOnly = true;
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
  if (parsed.buildOnly && (parsed.image || parsed.rendererRelease)) {
    fail("--build-only builds this commit: it takes no --image and no --renderer-release.");
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
