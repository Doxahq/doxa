import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const script = path.resolve(import.meta.dirname, "../deploy-api-ecs.mjs");

// Each case fails while reading its arguments, before any AWS CLI call. An
// empty PATH makes sure of it: a call to `aws` would fail with another message.
function runScript(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: "" } });
}

const IMAGE = "123456789012.dkr.ecr.us-east-1.amazonaws.com/doxa-api:abc1234";
const REVISION = "arn:aws:ecs:us-east-1:123456789012:task-definition/doxa-api-production:7";

test("needs a color", () => {
  const result = runScript(["--image", IMAGE]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pass --color blue\|green with --image or --revision, or --retire blue\|green/);
  assert.match(runScript(["--color", "red", "--image", IMAGE]).stderr, /Pass --color blue\|green/);
});

test("needs an image or a revision", () => {
  const result = runScript(["--color", "green"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pass --image to deploy, or --revision to roll back/);
});

test("refuses an image and a revision together", () => {
  const result = runScript(["--color", "green", "--image", IMAGE, "--revision", REVISION]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not both/);
});

test("refuses the latest tag", () => {
  const result = runScript(["--color", "green", "--image", "123456789012.dkr.ecr.us-east-1.amazonaws.com/doxa-api:latest"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /latest tag/);
});

test("refuses a revision that is not a task definition ARN", () => {
  const result = runScript(["--color", "blue", "--revision", "doxa-api-production"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--revision must be a task definition ARN/);
});

test("refuses unknown arguments", () => {
  const result = runScript(["--force"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument "--force"/);
});

test("refuses --env with a rollback", () => {
  const result = runScript(["--color", "blue", "--revision", REVISION, "--env", "A=1"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--env applies to --image deploys/);
});

test("refuses a malformed --env", () => {
  const result = runScript(["--color", "green", "--image", IMAGE, "--env", "bad"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NAME=VALUE/);
});

test("retires one known color, and nothing else at the same time", () => {
  assert.match(runScript(["--retire", "purple"]).stderr, /--retire needs blue or green/);
  assert.match(runScript(["--retire", "blue", "--image", IMAGE]).stderr, /--retire takes no --color, --image, --revision or --env/);
});
