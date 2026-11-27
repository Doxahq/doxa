#!/usr/bin/env node
// Production deployment, in one place for `pnpm deploy:all` and the Deploy
// Production workflow. The workflow runs each step with `--step`, so a failed
// service shows as its own CI step.
//
//   node scripts/deploy/deploy-production.mjs                  every step, in order
//   node scripts/deploy/deploy-production.mjs --from <step>    resume at a step (the staged release stays)
//   node scripts/deploy/deploy-production.mjs --step <step>    one step
//   node scripts/deploy/deploy-production.mjs --list           print the steps
//
// Roll the live release back with: node scripts/deploy/release.mjs rollback
// The watch step holds for 15 minutes; DOXA_RELEASE_HOLD_MINUTES changes it.
// A release reads the Cloudflare API, so it needs CLOUDFLARE_ACCOUNT_ID.
//
// The docs-rendering step needs --previous-fallback on|off (or the
// DOXA_RENDERER_PREVIOUS_FALLBACK variable): see apps/docs-template/scripts/
// deploy-renderer.mjs. It is checked before the first step runs.
//
// A local run refuses a dirty working tree, because it deploys the files on
// disk. Pass --allow-dirty to deploy them anyway.

import { spawnSync } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { EXCLUDE_WRANGLER_CONFIGS, assertIdsFilled } from "./lib/production-ids.mjs";

const RENDERER_HEAP = "--max-old-space-size=4096";

/**
 * The release, in phases (scripts/deploy/release.mjs):
 *
 *   1. release   start the release: contract check against the live release
 *   2. stage     each service step uploads its new version without traffic.
 *                The api step starts the new origin on the idle ECS color. A
 *                Worker that only `wrangler deploy` can ship (the agent
 *                container, a new Durable Object migration) deploys live here.
 *   3. flip      serve every staged version, callees first, in about 30 seconds
 *   4. verify    smoke-check production; a failure rolls everything back
 *   5. watch     keep checking while the old API color still runs, then stop it
 *
 * The stage steps can run in any order. Their flip order is in
 * scripts/deploy/lib/release/services.mjs.
 */
const STEPS = [
  { name: "validate", title: "Validate production configuration", command: ["pnpm", "validate:production-config"] },
  // agent-worker bundles @doxahq/agent, and the API, web and renderer bundle
  // @doxahq/mdx-runtime, from their dist/ folders.
  { name: "packages", title: "Build workspace packages", command: ["pnpm", "--filter", "./packages/**", "build"] },
  { name: "release", title: "Start the release", command: ["node", "scripts/deploy/release.mjs", "init"] },
  stageStep("docs-resolver", "the private docs resolver"),
  stageStep("docs-runtime", "the docs runtime"),
  stageStep("try-proxy", "the playground proxy"),
  stageStep("search-gateway", "the search gateway"),
  {
    name: "docs-rendering",
    title: "Stage the docs renderer, dispatcher and prerenderer",
    command: ["pnpm", "deploy:docs-template", "--", "--stage"],
    // The renderer SSR build runs out of memory at Node's default heap.
    env: { NODE_OPTIONS: withNodeOption(process.env.NODE_OPTIONS, RENDERER_HEAP) },
  },
  // After docs-rendering, which writes the renderer release of the origin.
  { name: "api", title: "Start the API origin on the idle color and stage the edge", command: ["node", "scripts/deploy/deploy-api.mjs", "--stage"] },
  stageStep("email-worker", "the email Worker"),
  stageStep("mcp", "the MCP Worker"),
  {
    ...stageStep("agent-container", "the agent container"),
    // Containers roll out only with wrangler deploy, so it is live from here.
    title: "Deploy the agent container (live now)",
    // The image pushes fail now and then; a second attempt usually passes.
    attempts: 2,
    retryDelayMs: 30_000,
  },
  stageStep("agent-worker", "the agent Worker"),
  stageStep("web", "the web app"),
  { name: "flip", title: "Flip production to the new versions", command: ["node", "scripts/deploy/release.mjs", "flip"] },
  { name: "verify", title: "Smoke-check production", command: ["node", "scripts/deploy/release.mjs", "verify"] },
  { name: "watch", title: "Watch the release, then stop the old API color", command: ["node", "scripts/deploy/release.mjs", "watch"] },
];

function stageStep(service, label) {
  return { name: service, title: `Stage ${label}`, command: ["node", "scripts/deploy/release.mjs", "stage", service] };
}

const options = parseArgs(process.argv.slice(2));

if (options.list) {
  for (const step of STEPS) console.log(`${step.name.padEnd(16)} ${step.title}`);
  process.exit(0);
}

const selected = selectSteps(options);
const previousFallback = options.previousFallback ?? process.env.DOXA_RENDERER_PREVIOUS_FALLBACK?.trim();
if (selected.some((step) => step.name === "docs-rendering") && previousFallback !== "on" && previousFallback !== "off") {
  fail(
    previousFallback
      ? `Invalid --previous-fallback value "${previousFallback}". Expected on or off.`
      : "The docs-rendering step needs --previous-fallback on|off. Pass off for a security fix or a bad renderer build; pass on otherwise.",
  );
}
if (previousFallback) process.env.DOXA_RENDERER_PREVIOUS_FALLBACK = previousFallback;
if (!options.allowDirty && !process.env.CI) assertCleanTree();
// The ops repo fills the Cloudflare IDs before a deploy (scripts/deploy/apply-production-ids.mjs).
try {
  assertIdsFilled(process.cwd());
} catch (error) {
  fail(error.message);
}
// scripts/deploy/deploy-api.mjs builds the API image, and asks for the same consent.
if (options.allowDirty) process.env.DOXA_DEPLOY_ALLOW_DIRTY = "1";

const startedAt = Date.now();
for (const step of selected) {
  await runStep(step);
}
console.log(`\n[deploy] Done: ${selected.map((step) => step.name).join(", ")} (${formatDuration(Date.now() - startedAt)}).`);

async function runStep(step) {
  const attempts = step.attempts ?? 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const suffix = attempts > 1 ? ` (attempt ${attempt}/${attempts})` : "";
    console.log(`\n[deploy] ── ${step.title}${suffix}`);
    console.log(`[deploy] $ ${step.command.join(" ")}`);
    const stepStartedAt = Date.now();
    const result = spawnSync(step.command[0], step.command.slice(1), {
      stdio: "inherit",
      env: { ...process.env, ...step.env },
    });
    if (result.status === 0) {
      console.log(`[deploy] ✓ ${step.name} (${formatDuration(Date.now() - stepStartedAt)})`);
      return;
    }
    if (attempt < attempts) {
      console.warn(`[deploy] ${step.name} failed. Retrying in ${step.retryDelayMs / 1000} seconds.`);
      await sleep(step.retryDelayMs);
    }
  }
  const index = STEPS.indexOf(step);
  console.error(`\n[deploy] ✗ ${step.name} failed.`);
  if (index < STEPS.findIndex((candidate) => candidate.name === "flip")) {
    console.error("[deploy] Production still serves the previous release: staged versions get no traffic.");
    console.error("[deploy] The agent container, and a Worker with a new Durable Object migration, deploy live when staged.");
  }
  console.error(`[deploy] Fix the cause, then resume: pnpm deploy:all --from ${step.name}`);
  process.exit(1);
}

function selectSteps({ step, from }) {
  const find = (name) => {
    const index = STEPS.findIndex((candidate) => candidate.name === name);
    if (index === -1) fail(`Unknown step "${name}". Steps: ${STEPS.map((s) => s.name).join(", ")}`);
    return index;
  };
  if (step) return [STEPS[find(step)]];
  if (from) return STEPS.slice(find(from));
  return STEPS;
}

function assertCleanTree() {
  const status = spawnSync("git", ["status", "--porcelain", "--", ".", ...EXCLUDE_WRANGLER_CONFIGS], { encoding: "utf8" });
  if (status.status !== 0) fail("Cannot read git status.");
  const changes = status.stdout.trim();
  if (!changes) return;
  const count = changes.split("\n").length;
  fail(
    `The working tree has ${count} uncommitted change(s), and a local deploy ships the files on disk.\n` +
      "Commit or stash them, or pass --allow-dirty to deploy them anyway.",
  );
}

function withNodeOption(current, option) {
  const flag = option.split("=")[0];
  if (current?.includes(flag)) return current;
  return [current, option].filter(Boolean).join(" ");
}

function parseArgs(args) {
  const parsed = { allowDirty: false, list: false, step: undefined, from: undefined, previousFallback: undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--allow-dirty") parsed.allowDirty = true;
    else if (arg === "--list") parsed.list = true;
    else if (arg === "--step" || arg === "--from") {
      const value = args[++i];
      if (!value) fail(`${arg} needs a step name.`);
      parsed[arg.slice(2)] = value;
    } else if (arg === "--previous-fallback") {
      const value = args[++i];
      if (!value) fail("--previous-fallback needs on or off.");
      parsed.previousFallback = value;
    } else {
      fail(`Unknown argument "${arg}". Use --step, --from, --list, --allow-dirty or --previous-fallback.`);
    }
  }
  if (parsed.step && parsed.from) fail("Use --step or --from, not both.");
  return parsed;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function fail(message) {
  console.error(`[deploy] ${message}`);
  process.exit(1);
}
