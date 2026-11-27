import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const script = path.join(workspaceRoot, "scripts", "deploy", "deploy-production.mjs");
// The Deploy Production workflow lives in the operator's private ops repo. Its
// deploy job runs this test with DOXA_DEPLOY_WORKFLOW set to that workflow.
const workflow = process.env.DOXA_DEPLOY_WORKFLOW;

// The workflow runs these before its deploy steps, as its own CI steps.
const CI_SETUP_STEPS = ["validate", "packages"];

function scriptSteps() {
  const result = spawnSync(process.execPath, [script, "--list"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n").map((line) => line.split(/\s+/)[0]);
}

test("the workflow deploys every script step, in the script's order", { skip: !workflow && "DOXA_DEPLOY_WORKFLOW is not set" }, () => {
  const workflowSteps = [...readFileSync(workflow, "utf8").matchAll(/deploy-production\.mjs --step (\S+)/g)].map(
    (match) => match[1],
  );

  assert.deepEqual(
    workflowSteps,
    scriptSteps().filter((step) => !CI_SETUP_STEPS.includes(step)),
  );
});

test("a release starts first, stages every service, then flips, verifies and watches", () => {
  const steps = scriptSteps().filter((step) => !CI_SETUP_STEPS.includes(step));

  assert.equal(steps[0], "release");
  assert.deepEqual(steps.slice(-3), ["flip", "verify", "watch"]);
  // The api step reads the renderer release that the docs-rendering step writes.
  assert.ok(steps.indexOf("api") > steps.indexOf("docs-rendering"));
});

test("rejects an unknown step", () => {
  const result = spawnSync(process.execPath, [script, "--step", "nope"], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown step "nope"/);
});

function runWithoutFallbackEnv(args) {
  const env = { ...process.env };
  delete env.DOXA_RENDERER_PREVIOUS_FALLBACK;
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
}

test("refuses the docs-rendering step without an explicit previous-fallback choice", () => {
  for (const args of [["--step", "docs-rendering"], ["--from", "docs-runtime"], []]) {
    const result = runWithoutFallbackEnv(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs --previous-fallback on\|off/);
  }
});

test("rejects an invalid previous-fallback value", () => {
  const result = runWithoutFallbackEnv(["--step", "docs-rendering", "--previous-fallback", "yes"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected on or off/);
});
