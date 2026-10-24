import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { jobChildArguments, runJobChild, type JobChildRun } from "../src/job-child";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const nodeMajor = Number(process.versions.node.split(".")[0]);

function run(fixture: string, overrides: Partial<JobChildRun> = {}) {
  return runJobChild({
    entry: join(fixtures, fixture),
    readDirectory: fixtures,
    heapMb: 64,
    input: new TextEncoder().encode("hello"),
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    ...overrides,
  });
}

describe("job child", () => {
  test("locks the child down with the permission model", () => {
    expect(jobChildArguments({ entry: "/app/job/job.mjs", readDirectory: "/app/job", heapMb: 768 })).toEqual([
      "--permission",
      "--allow-fs-read=/app/job",
      "--disallow-code-generation-from-strings",
      "--disable-proto=delete",
      "--disable-sigusr1",
      "--max-old-space-size=768",
      "/app/job/job.mjs",
    ]);
  });

  test("passes the input on stdin and returns the outcome from stdout", async () => {
    await expect(run("echo-job.mjs")).resolves.toEqual({ ok: true, output: "hello" });
  });

  test("gives the child no environment, no files outside its folder, no writes and no code from strings", async () => {
    const outcome = await run("probe-job.mjs");

    expect(outcome).toMatchObject({
      ok: true,
      output: {
        readOutside: "denied",
        write: "denied",
        childProcess: "denied",
        eval: "denied",
        environmentKeys: 0,
        proto: "deleted",
      },
    });
  });

  test.skipIf(nodeMajor < 25)("gives the child no network on Node 25 and later", async () => {
    const outcome = await run("probe-job.mjs");

    expect(outcome).toMatchObject({ ok: true, output: { fetch: "denied", tcp: "denied" } });
  });

  test("kills a child that runs longer than its time limit", async () => {
    await expect(run("hang-job.mjs", { timeoutMs: 300 })).resolves.toEqual({
      ok: false,
      error: { code: "timeout", message: "The job did not finish within 300 ms." },
    });
  });

  test("kills a child that writes more than the output limit", async () => {
    const outcome = await run("noisy-job.mjs", { maxOutputBytes: 1_000 });

    expect(outcome.ok ? undefined : outcome.error.code).toBe("output_too_large");
  });

  test("reports a child that ends without an outcome", async () => {
    await expect(run("crash-job.mjs")).resolves.toEqual({
      ok: false,
      error: { code: "crashed", message: "The job process ended with exit code 3." },
    });
  });

  test("stops the child when the call is cancelled", async () => {
    const controller = new AbortController();
    const pending = run("hang-job.mjs", { signal: controller.signal });
    controller.abort();

    const outcome = await pending;
    expect(outcome.ok ? undefined : outcome.error.code).toBe("job_failed");
  });
});
