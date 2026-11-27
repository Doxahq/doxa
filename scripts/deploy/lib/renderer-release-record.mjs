// The renderer release record: which renderer build is deployed, and which
// build the docs dispatcher may serve from cache while the new build warms
// (M26, the previous-build fallback). The deploy reads it from R2 before
// packaging and writes it after a successful dispatcher deploy. Everything
// here is pure, so the rules are unit-tested; scripts/deploy-renderer.mjs and
// apps/docs-dispatcher/scripts/package-renderer.mjs do the I/O.
// See docs/current/docs-artifact-compatibility.md, "Previous-build fallback".

/** In the renderer code bucket (`doxa-docs-renderer-code`). */
export const RENDERER_RELEASE_RECORD_KEY = "renderer-code/releases/current.json";

/** Old revocations beyond this count are dropped from the record. */
const MAX_REVOKED = 100;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * `on`: a new release may use the build it replaces as the fallback.
 * `off`: no fallback for this deploy, for example a security fix.
 * There is no default: the operator decides on every deploy (F10).
 */
export function parsePreviousFallbackOption(value) {
  if (value === "on" || value === "off") return value;
  throw new Error(
    value === undefined || value === ""
      ? "--previous-fallback on|off is required. Pass off for a security fix or when the current build must not be served again; pass on otherwise."
      : `Invalid --previous-fallback value ${JSON.stringify(value)}. Expected on or off.`,
  );
}

export function parseRevokedReleaseId(value) {
  if (typeof value === "string" && SHA256.test(value)) return value;
  throw new Error(
    `Invalid --revoke value ${JSON.stringify(value)}. Expected a 64-character renderer release ID.`,
  );
}

/**
 * Parses the stored record. Null text means "no record yet" (the first deploy
 * with this code). A malformed record stops the deploy: fix or delete it.
 */
export function parseRendererReleaseRecord(text) {
  if (text === null) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${RENDERER_RELEASE_RECORD_KEY} is not valid JSON.`);
  }
  const problem = findRecordProblem(value);
  if (problem) {
    throw new Error(`${RENDERER_RELEASE_RECORD_KEY} is invalid: ${problem}.`);
  }
  return {
    buildId: value.buildId,
    releaseId: value.releaseId,
    packageKey: value.packageKey,
    deployedAt: value.deployedAt,
    previous: value.previous
      ? { buildId: value.previous.buildId, releaseId: value.previous.releaseId }
      : null,
    revoked: [...value.revoked],
  };
}

function findRecordProblem(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "not an object";
  }
  if (!SHA256.test(value.buildId ?? "")) return "buildId";
  if (!SHA256.test(value.releaseId ?? "")) return "releaseId";
  if (typeof value.packageKey !== "string" || !value.packageKey) {
    return "packageKey";
  }
  if (!isIsoTime(value.deployedAt)) return "deployedAt";
  if (value.previous !== null) {
    if (
      typeof value.previous !== "object" ||
      !SHA256.test(value.previous?.buildId ?? "") ||
      !SHA256.test(value.previous?.releaseId ?? "")
    ) {
      return "previous";
    }
  }
  if (
    !Array.isArray(value.revoked) ||
    !value.revoked.every((id) => typeof id === "string" && SHA256.test(id))
  ) {
    return "revoked";
  }
  return null;
}

/**
 * Decides the previous build for a deploy of `current`:
 * - `off` → none.
 * - no record → none (nothing is known about the build being replaced).
 * - the same release again → keep the record's previous build and time.
 * - the record's previous release (a rollback) → none, automatically.
 * - otherwise the record's build becomes the previous build.
 * A revoked release, or one equal to `current`, is never the previous build.
 */
export function planPreviousBuild({
  record,
  current,
  previousFallback,
  revoke = [],
  now,
}) {
  const revoked = new Set([...(record?.revoked ?? []), ...revoke]);
  const sameRelease = record?.releaseId === current.releaseId;
  const deployedAt = sameRelease ? record.deployedAt : now;
  const decide = () => {
    if (previousFallback === "off") return { previous: null, reason: "fallback_off" };
    if (!record) return { previous: null, reason: "no_record" };
    if (sameRelease) {
      return { previous: record.previous, reason: "same_release" };
    }
    if (record.previous?.releaseId === current.releaseId) {
      return { previous: null, reason: "rollback" };
    }
    return {
      previous: { buildId: record.buildId, releaseId: record.releaseId },
      reason: "new_release",
    };
  };
  const decision = decide();
  if (decision.previous && revoked.has(decision.previous.releaseId)) {
    return { previous: null, reason: "revoked", deployedAt };
  }
  if (
    decision.previous &&
    (decision.previous.buildId === current.buildId ||
      decision.previous.releaseId === current.releaseId)
  ) {
    return { previous: null, reason: "same_as_current", deployedAt };
  }
  return { ...decision, deployedAt };
}

/** The record to write after the dispatcher deploy succeeded. */
export function createRendererReleaseRecord({
  record,
  current,
  plan,
  revoke = [],
}) {
  const revoked = [...new Set([...(record?.revoked ?? []), ...revoke])].slice(
    -MAX_REVOKED,
  );
  return {
    buildId: current.buildId,
    releaseId: current.releaseId,
    packageKey: current.packageKey,
    deployedAt: plan.deployedAt,
    previous: plan.previous,
    revoked,
  };
}

/**
 * True only when `wrangler r2 object get` failed because the record key does
 * not exist yet: R2's `NoSuchKey`, its API error code 10007, or the exact
 * "The specified key does not exist" text. A false "missing" is not safe: the
 * deploy would rebuild the record from nothing and drop `revoked`, so any
 * other failure (a missing bucket, auth, network) stops the deploy.
 */
export function isMissingObjectOutput(output) {
  return /\bNoSuchKey\b|\bcode:?\s*10007\b|The specified key does not exist/i.test(
    output,
  );
}

/** Attempts and waits (ms) for the release-record write (FC-M4). */
export const RELEASE_RECORD_WRITE_DELAYS_MS = [2_000, 5_000];

/**
 * Runs `attempt` until it returns true, waiting `delaysMs[i]` before retry
 * i + 1, so there are `delaysMs.length + 1` attempts. Returns whether one
 * succeeded and how many ran.
 */
export async function retryReleaseRecordWrite({
  attempt,
  sleep,
  delaysMs = RELEASE_RECORD_WRITE_DELAYS_MS,
}) {
  for (let index = 0; ; index += 1) {
    if (await attempt(index + 1)) return { ok: true, attempts: index + 1 };
    if (index >= delaysMs.length) return { ok: false, attempts: index + 1 };
    await sleep(delaysMs[index]);
  }
}

/** The `wrangler` arguments that write the record file to the code bucket. */
export function releaseRecordPutArgs(bucket, filePath) {
  return [
    "exec",
    "wrangler",
    "r2",
    "object",
    "put",
    `${bucket}/${RENDERER_RELEASE_RECORD_KEY}`,
    "--file",
    filePath,
    "--content-type",
    "application/json",
    "--remote",
    "--force",
  ];
}

/**
 * The operator message when every write failed. The dispatcher already
 * serves the new build, so without this record the next deploy plans the
 * wrong previous build. It gives the exact JSON and the exact command.
 */
export function describeReleaseRecordWriteFailure({
  bucket,
  record,
  filePath,
  cwd,
  attempts,
}) {
  return [
    `The release record ${bucket}/${RENDERER_RELEASE_RECORD_KEY} was not written after ${attempts} attempts.`,
    "The dispatcher already serves the new build. Write the record by hand before the next renderer deploy, or that deploy plans the wrong previous build.",
    `Record (also saved at ${filePath}):`,
    JSON.stringify(record, null, 2),
    `Command (run in ${cwd}):`,
    `pnpm ${releaseRecordPutArgs(bucket, filePath).join(" ")}`,
  ].join("\n");
}

/** The dispatcher vars of a plan. Empty strings mean "no fallback". */
export function previousBuildVars(plan) {
  return {
    DOXA_PREVIOUS_RENDERER_BUILD_ID: plan.previous?.buildId ?? "",
    DOXA_PREVIOUS_RENDERER_RELEASE_ID: plan.previous?.releaseId ?? "",
    DOXA_RENDERER_DEPLOYED_AT: plan.deployedAt ?? "",
  };
}

/**
 * Checks the generated dispatcher vars (F24): each previous ID is empty or
 * SHA-256 hex, both or neither are set, they differ from the deployed build,
 * and the deploy time is a valid ISO time when a previous build is set.
 */
export function findPreviousBuildVarsProblem(vars) {
  const buildId = vars?.DOXA_PREVIOUS_RENDERER_BUILD_ID;
  const releaseId = vars?.DOXA_PREVIOUS_RENDERER_RELEASE_ID;
  const deployedAt = vars?.DOXA_RENDERER_DEPLOYED_AT;
  for (const [name, value] of [
    ["DOXA_PREVIOUS_RENDERER_BUILD_ID", buildId],
    ["DOXA_PREVIOUS_RENDERER_RELEASE_ID", releaseId],
  ]) {
    if (typeof value !== "string" || (value !== "" && !SHA256.test(value))) {
      return `${name} must be empty or a 64-character hex ID`;
    }
  }
  if ((buildId === "") !== (releaseId === "")) {
    return "DOXA_PREVIOUS_RENDERER_BUILD_ID and DOXA_PREVIOUS_RENDERER_RELEASE_ID must both be set or both be empty";
  }
  if (typeof deployedAt !== "string") {
    return "DOXA_RENDERER_DEPLOYED_AT must be a string";
  }
  if (buildId === "") return null;
  if (buildId === vars.DOXA_RENDERER_BUILD_ID) {
    return "the previous renderer build equals the deployed build";
  }
  if (releaseId === vars.DOXA_RENDERER_RELEASE_ID) {
    return "the previous renderer release equals the deployed release";
  }
  if (!isIsoTime(deployedAt)) {
    return "DOXA_RENDERER_DEPLOYED_AT must be an ISO time when a previous build is set";
  }
  return null;
}

function isIsoTime(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
