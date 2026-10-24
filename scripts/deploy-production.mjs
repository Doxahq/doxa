#!/usr/bin/env node
// Production deployment, in one place for `pnpm deploy:all` and the Deploy
// Production workflow. The workflow runs each step with `--step`, so a failed
// service shows as its own CI step.
//
//   node scripts/deploy-production.mjs                  every step, in order
//   node scripts/deploy-production.mjs --from <step>    resume at a step
//   node scripts/deploy-production.mjs --step <step>    one step
//   node scripts/deploy-production.mjs --list           print the steps
//
// A local run refuses a dirty working tree, because it deploys the files on
// disk. Pass --allow-dirty to deploy them anyway.

import { spawnSync } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { EXCLUDE_WRANGLER_CONFIGS, assertIdsFilled } from "./lib/production-ids.mjs";

const RENDERER_HEAP = "--max-old-space-size=4096";

/**
 * The deployment order. The docs-rendering step also deploys the API last:
 * the renderer release writes apps/api/dist/wrangler.production.json, and
 * scripts/deploy-api.mjs deploys the Node origin on ECS with that release,
 * then the thin doxa-api Worker. The API goes before the Workers that call it:
 * the email Worker, the MCP Worker, the agent container and the agent Worker.
 */
const STEPS = [
  { name: "validate", title: "Validate production configuration", command: ["pnpm", "validate:production-config"] },
  // agent-worker bundles @doxahq/agent, and the API, web and renderer bundle
  // @doxahq/mdx-runtime, from their dist/ folders.
  { name: "packages", title: "Build workspace packages", command: ["pnpm", "--filter", "./packages/**", "build"] },
  { name: "docs-resolver", title: "Deploy the private docs resolver", command: ["pnpm", "deploy:docs-resolver"] },
  { name: "docs-runtime", title: "Deploy the docs runtime", command: ["pnpm", "deploy:docs-runtime"] },
  {
    name: "docs-rendering",
    title: "Deploy the docs renderer, dispatcher, prerenderer and API",
    command: ["pnpm", "deploy:docs-template", "--", "--skip-secret"],
    // The renderer SSR build runs out of memory at Node's default heap.
    env: { NODE_OPTIONS: withNodeOption(process.env.NODE_OPTIONS, RENDERER_HEAP) },
  },
  // Both bind to entrypoints of doxa-api-production, so they follow the API.
  { name: "email-worker", title: "Deploy the email Worker", command: ["pnpm", "deploy:email-worker"] },
  { name: "mcp", title: "Deploy the MCP Worker", command: ["pnpm", "deploy:mcp"] },
  {
    name: "agent-container",
    title: "Deploy the agent container",
    command: ["pnpm", "deploy:agent-container"],
    // The image pushes fail now and then; a second attempt usually passes.
    attempts: 2,
    retryDelayMs: 30_000,
  },
  { name: "agent-worker", title: "Deploy the agent Worker", command: ["pnpm", "deploy:agent-worker"] },
  { name: "web", title: "Deploy the web app", command: ["pnpm", "deploy:web"] },
];

const options = parseArgs(process.argv.slice(2));

if (options.list) {
  for (const step of STEPS) console.log(`${step.name.padEnd(16)} ${step.title}`);
  process.exit(0);
}

const selected = selectSteps(options);
if (!options.allowDirty && !process.env.CI) assertCleanTree();
// The ops repo fills the Cloudflare IDs before a deploy (scripts/apply-production-ids.mjs).
try {
  assertIdsFilled(process.cwd());
} catch (error) {
  fail(error.message);
}
// scripts/deploy-api.mjs builds the API image, and asks for the same consent.
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
  console.error(`\n[deploy] ✗ ${step.name} failed. The steps before it are deployed.`);
  console.error(`[deploy] Fix the cause, then resume: pnpm deploy:all --from ${step.name}`);
  if (index > 0) console.error(`[deploy] Deployed already: ${STEPS.slice(0, index).map((s) => s.name).join(", ")}`);
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
  const parsed = { allowDirty: false, list: false, step: undefined, from: undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--allow-dirty") parsed.allowDirty = true;
    else if (arg === "--list") parsed.list = true;
    else if (arg === "--step" || arg === "--from") {
      const value = args[++i];
      if (!value) fail(`${arg} needs a step name.`);
      parsed[arg.slice(2)] = value;
    } else {
      fail(`Unknown argument "${arg}". Use --step, --from, --list or --allow-dirty.`);
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
