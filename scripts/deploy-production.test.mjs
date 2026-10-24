import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(workspaceRoot, "scripts", "deploy-production.mjs");
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

test("the API deploys before every Worker that binds to it", () => {
  const steps = scriptSteps();
  const api = steps.indexOf("docs-rendering");

  for (const dependent of ["email-worker", "mcp", "agent-container", "agent-worker"]) {
    assert.ok(steps.indexOf(dependent) > api, dependent);
  }
});

test("rejects an unknown step", () => {
  const result = spawnSync(process.execPath, [script, "--step", "nope"], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown step "nope"/);
});
