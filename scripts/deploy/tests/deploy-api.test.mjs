import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { assertRendererRelease, imageBuildArgs, imageTagFor, rendererReleaseOf } from "../lib/api-deploy.mjs";

const script = path.resolve(import.meta.dirname, "../deploy-api.mjs");
const IMAGE = "123456789012.dkr.ecr.us-east-1.amazonaws.com/doxa-api:0123456789ab";

// Each case fails while reading its arguments, before any git, AWS or Docker
// call. An empty PATH makes sure of it: such a call would fail with another message.
function runScript(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: "" } });
}

test("tags a clean tree with its commit, and a dirty tree with the time too", () => {
  assert.equal(imageTagFor({ commit: "0123456789ab", dirty: false }), "0123456789ab");
  assert.equal(
    imageTagFor({ commit: "0123456789ab", dirty: true, now: new Date("2026-10-24T16:05:09.123Z") }),
    "0123456789ab-dirty-20261024-160509",
  );
  assert.throws(() => imageTagFor({ commit: "HEAD", dirty: false }), /12-character git commit/);
});

test("reads the renderer release of the generated API config", () => {
  const config = { env: { production: { vars: { DOXA_RENDERER_RELEASE_ID: "r-2026-10-24.abc123" } } } };
  assert.equal(rendererReleaseOf(config), "r-2026-10-24.abc123");
  assert.throws(() => rendererReleaseOf({ env: { production: { vars: {} } } }), /not a renderer release ID/);
  assert.throws(() => assertRendererRelease("unconfigured"), /not a renderer release ID/);
  assert.throws(() => assertRendererRelease("a b"), /not a renderer release ID/);
  assert.throws(() => assertRendererRelease("x;rm -rf /"), /not a renderer release ID/);
});

test("builds the image for Graviton and pushes it", () => {
  assert.deepEqual(imageBuildArgs(IMAGE), ["buildx", "build", "--platform", "linux/arm64", "-f", "apps/api/Dockerfile", "-t", IMAGE, "--push", "."]);
});

test("refuses unknown arguments and missing values", () => {
  assert.match(runScript(["--imgae", IMAGE]).stderr, /Unknown argument "--imgae"/);
  assert.match(runScript(["--image"]).stderr, /--image needs a value/);
  assert.match(runScript(["--renderer-release", "--image", IMAGE]).stderr, /--renderer-release needs a value/);
});

test("refuses --build-only with an image, a release or --stage", () => {
  for (const extra of [["--image", IMAGE], ["--renderer-release", "r-1"], ["--stage"]]) {
    const result = runScript(["--build-only", ...extra]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--build-only builds this commit/);
  }
});

test("refuses the latest tag before any deploy", () => {
  const result = runScript(["--image", "123456789012.dkr.ecr.us-east-1.amazonaws.com/doxa-api:latest"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /latest tag/);
});
