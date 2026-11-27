import assert from "node:assert/strict";
import test from "node:test";

import {
  RENDERER_RELEASE_RECORD_KEY,
  createRendererReleaseRecord,
  describeReleaseRecordWriteFailure,
  findPreviousBuildVarsProblem,
  isMissingObjectOutput,
  parsePreviousFallbackOption,
  parseRendererReleaseRecord,
  parseRevokedReleaseId,
  planPreviousBuild,
  previousBuildVars,
  releaseRecordPutArgs,
  retryReleaseRecordWrite,
} from "../lib/renderer-release-record.mjs";

const A = { buildId: "a".repeat(64), releaseId: "1".repeat(64) };
const B = { buildId: "b".repeat(64), releaseId: "2".repeat(64) };
const C = { buildId: "c".repeat(64), releaseId: "3".repeat(64) };
const NOW = "2026-10-29T12:00:00.000Z";
const EARLIER = "2026-10-20T08:00:00.000Z";

function record(current, previous, revoked = []) {
  return {
    ...current,
    packageKey: `renderer-code/${current.buildId}.json.gz`,
    deployedAt: EARLIER,
    previous,
    revoked,
  };
}

test("stores the record next to the renderer packages", () => {
  assert.equal(RENDERER_RELEASE_RECORD_KEY, "renderer-code/releases/current.json");
});

test("requires an explicit previous-fallback choice (F10)", () => {
  assert.equal(parsePreviousFallbackOption("on"), "on");
  assert.equal(parsePreviousFallbackOption("off"), "off");
  assert.throws(() => parsePreviousFallbackOption(undefined), /--previous-fallback on\|off is required/);
  assert.throws(() => parsePreviousFallbackOption(""), /is required/);
  assert.throws(() => parsePreviousFallbackOption("true"), /Expected on or off/);
});

test("accepts only release IDs for --revoke", () => {
  assert.equal(parseRevokedReleaseId(A.releaseId), A.releaseId);
  assert.throws(() => parseRevokedReleaseId("abc"), /64-character renderer release ID/);
});

test("a new release uses the deployed build as its previous build", () => {
  assert.deepEqual(
    planPreviousBuild({ record: record(A, null), current: B, previousFallback: "on", now: NOW }),
    { previous: A, reason: "new_release", deployedAt: NOW },
  );
});

test("off gives no previous build, but keeps the deploy time", () => {
  assert.deepEqual(
    planPreviousBuild({ record: record(A, null), current: B, previousFallback: "off", now: NOW }),
    { previous: null, reason: "fallback_off", deployedAt: NOW },
  );
});

test("the first deploy has no previous build", () => {
  assert.deepEqual(
    planPreviousBuild({ record: null, current: B, previousFallback: "on", now: NOW }),
    { previous: null, reason: "no_record", deployedAt: NOW },
  );
});

test("a redeploy of the same release keeps the previous build and the window", () => {
  assert.deepEqual(
    planPreviousBuild({ record: record(B, A), current: B, previousFallback: "on", now: NOW }),
    { previous: A, reason: "same_release", deployedAt: EARLIER },
  );
  assert.deepEqual(
    planPreviousBuild({ record: record(B, null), current: B, previousFallback: "on", now: NOW }),
    { previous: null, reason: "same_release", deployedAt: EARLIER },
  );
});

test("a rollback to the previous release empties the previous build automatically", () => {
  assert.deepEqual(
    planPreviousBuild({ record: record(B, A), current: A, previousFallback: "on", now: NOW }),
    { previous: null, reason: "rollback", deployedAt: NOW },
  );
});

test("a revoked release is never the previous build", () => {
  assert.deepEqual(
    planPreviousBuild({
      record: record(B, A, [B.releaseId]),
      current: C,
      previousFallback: "on",
      now: NOW,
    }),
    { previous: null, reason: "revoked", deployedAt: NOW },
  );
  assert.deepEqual(
    planPreviousBuild({
      record: record(B, A),
      current: C,
      previousFallback: "on",
      revoke: [B.releaseId],
      now: NOW,
    }),
    { previous: null, reason: "revoked", deployedAt: NOW },
  );
  assert.deepEqual(
    planPreviousBuild({
      record: record(B, A),
      current: B,
      previousFallback: "on",
      revoke: [A.releaseId],
      now: NOW,
    }),
    { previous: null, reason: "revoked", deployedAt: EARLIER },
  );
});

test("a previous build that shares the deployed build ID is dropped", () => {
  const sameBuild = { buildId: B.buildId, releaseId: C.releaseId };
  assert.deepEqual(
    planPreviousBuild({ record: record(B, null), current: sameBuild, previousFallback: "on", now: NOW }),
    { previous: null, reason: "same_as_current", deployedAt: NOW },
  );
});

test("writes the next record with the plan and every revocation", () => {
  const plan = planPreviousBuild({
    record: record(A, null, [C.releaseId]),
    current: B,
    previousFallback: "on",
    now: NOW,
  });
  assert.deepEqual(
    createRendererReleaseRecord({
      record: record(A, null, [C.releaseId]),
      current: { ...B, packageKey: "renderer-code/b.json.gz" },
      plan,
      revoke: [C.releaseId, "4".repeat(64)],
    }),
    {
      ...B,
      packageKey: "renderer-code/b.json.gz",
      deployedAt: NOW,
      previous: A,
      revoked: [C.releaseId, "4".repeat(64)],
    },
  );
});

test("keeps only the newest 100 revocations", () => {
  const revoked = Array.from({ length: 105 }, (_, index) => index.toString(16).padStart(64, "0"));
  const next = createRendererReleaseRecord({
    record: record(A, null, revoked),
    current: { ...B, packageKey: "k" },
    plan: { previous: null, deployedAt: NOW },
  });
  assert.equal(next.revoked.length, 100);
  assert.equal(next.revoked.at(-1), revoked.at(-1));
});

test("parses a stored record and treats a missing one as null", () => {
  const stored = record(B, A, [C.releaseId]);
  assert.deepEqual(parseRendererReleaseRecord(JSON.stringify(stored)), stored);
  assert.equal(parseRendererReleaseRecord(null), null);
});

test("stops the deploy on a malformed record", () => {
  for (const [text, field] of [
    ["{", "not valid JSON"],
    ["[]", "not an object"],
    [JSON.stringify({ ...record(B, null), buildId: "x" }), "buildId"],
    [JSON.stringify({ ...record(B, null), deployedAt: "yesterday" }), "deployedAt"],
    [JSON.stringify({ ...record(B, null), previous: { buildId: A.buildId } }), "previous"],
    [JSON.stringify({ ...record(B, null), revoked: ["x"] }), "revoked"],
    [JSON.stringify({ ...record(B, null), packageKey: "" }), "packageKey"],
  ]) {
    assert.throws(() => parseRendererReleaseRecord(text), new RegExp(field));
  }
});

test("turns a plan into dispatcher vars", () => {
  assert.deepEqual(previousBuildVars({ previous: A, deployedAt: NOW }), {
    DOXA_PREVIOUS_RENDERER_BUILD_ID: A.buildId,
    DOXA_PREVIOUS_RENDERER_RELEASE_ID: A.releaseId,
    DOXA_RENDERER_DEPLOYED_AT: NOW,
  });
  assert.deepEqual(previousBuildVars({ previous: null, deployedAt: "" }), {
    DOXA_PREVIOUS_RENDERER_BUILD_ID: "",
    DOXA_PREVIOUS_RENDERER_RELEASE_ID: "",
    DOXA_RENDERER_DEPLOYED_AT: "",
  });
});

test("checks the generated previous-build vars (F24)", () => {
  const vars = {
    DOXA_RENDERER_BUILD_ID: B.buildId,
    DOXA_RENDERER_RELEASE_ID: B.releaseId,
    ...previousBuildVars({ previous: A, deployedAt: NOW }),
  };
  assert.equal(findPreviousBuildVarsProblem(vars), null);
  assert.equal(
    findPreviousBuildVarsProblem({ ...vars, ...previousBuildVars({ previous: null, deployedAt: "" }) }),
    null,
  );
  for (const [change, message] of [
    [{ DOXA_PREVIOUS_RENDERER_BUILD_ID: "abc" }, /empty or a 64-character/],
    [{ DOXA_PREVIOUS_RENDERER_RELEASE_ID: undefined }, /empty or a 64-character/],
    [{ DOXA_PREVIOUS_RENDERER_RELEASE_ID: "" }, /both be set or both be empty/],
    [{ DOXA_PREVIOUS_RENDERER_BUILD_ID: B.buildId }, /equals the deployed build/],
    [{ DOXA_PREVIOUS_RENDERER_RELEASE_ID: B.releaseId }, /equals the deployed release/],
    [{ DOXA_RENDERER_DEPLOYED_AT: "" }, /ISO time/],
    [{ DOXA_RENDERER_DEPLOYED_AT: undefined }, /must be a string/],
  ]) {
    assert.match(findPreviousBuildVarsProblem({ ...vars, ...change }) ?? "", message);
  }
});

test("recognizes a missing record in the wrangler output", () => {
  assert.equal(isMissingObjectOutput("✘ [ERROR] The specified key does not exist."), true);
  assert.equal(isMissingObjectOutput("NoSuchKey"), true);
  assert.equal(isMissingObjectOutput("Authentication error [code: 10000]"), false);
  assert.equal(isMissingObjectOutput(""), false);
});

test("treats only a missing key as a missing record (FC-L8)", () => {
  assert.equal(isMissingObjectOutput("✘ [ERROR] Failed to fetch - 404: Not Found [code: 10007]"), true);
  // A false "missing" would rebuild the record from nothing and drop `revoked`.
  for (const output of [
    "✘ [ERROR] The specified bucket does not exist. [code: 10006]",
    "✘ [ERROR] A request to the Cloudflare API failed: Not Found",
    "Could not route to /accounts/x/r2/buckets: not found",
    "Error: the file does not exist",
    "request id 100070 failed",
  ]) {
    assert.equal(isMissingObjectOutput(output), false, output);
  }
});

test("retries the release-record write and reports the attempts (FC-M4)", async () => {
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
  };
  const results = [false, false, true];
  const ok = await retryReleaseRecordWrite({
    attempt: async (n) => results[n - 1],
    sleep,
    delaysMs: [10, 20],
  });
  assert.deepEqual(ok, { ok: true, attempts: 3 });
  assert.deepEqual(waits, [10, 20]);

  const failed = await retryReleaseRecordWrite({
    attempt: async () => false,
    sleep: async () => {},
    delaysMs: [10, 20],
  });
  assert.deepEqual(failed, { ok: false, attempts: 3 });

  let calls = 0;
  const first = await retryReleaseRecordWrite({
    attempt: async () => {
      calls += 1;
      return true;
    },
    sleep: async () => assert.fail("no wait after a success"),
  });
  assert.deepEqual(first, { ok: true, attempts: 1 });
  assert.equal(calls, 1);
});

test("prints the exact record and put command when the write failed (FC-M4)", () => {
  const record = { buildId: A.buildId, releaseId: A.releaseId, revoked: [] };
  const message = describeReleaseRecordWriteFailure({
    bucket: "doxa-docs-renderer-code",
    record,
    filePath: "dist/release-record.next.json",
    cwd: "apps/docs-dispatcher",
    attempts: 3,
  });
  assert.match(message, /not written after 3 attempts/);
  assert.ok(message.includes(JSON.stringify(record, null, 2)));
  assert.ok(
    message.includes(
      `pnpm exec wrangler r2 object put doxa-docs-renderer-code/${RENDERER_RELEASE_RECORD_KEY} --file dist/release-record.next.json --content-type application/json --remote --force`,
    ),
  );
  assert.deepEqual(releaseRecordPutArgs("b", "f").slice(0, 6), [
    "exec",
    "wrangler",
    "r2",
    "object",
    "put",
    `b/${RENDERER_RELEASE_RECORD_KEY}`,
  ]);
});
