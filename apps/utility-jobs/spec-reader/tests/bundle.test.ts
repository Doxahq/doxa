import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SPEC_READER_JOB } from "@doxahq/contracts/spec-reader";
import { runJobChild } from "@doxahq/utility-kit";
import { describe, expect, test } from "vitest";
import { openapi } from "./helpers";

const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const entry = fileURLToPath(new URL("../dist/job.mjs", import.meta.url));

function call(input: unknown) {
  return runJobChild({
    entry,
    readDirectory: distDirectory,
    heapMb: SPEC_READER_JOB.heapMb,
    timeoutMs: SPEC_READER_JOB.childTimeoutMs,
    maxOutputBytes: SPEC_READER_JOB.maxOutputBytes,
    input: new TextEncoder().encode(JSON.stringify(input)),
  });
}

/** The bundle that `pnpm test` builds first, in the child the job image runs. */
describe("job bundle", () => {
  test("reads a spec in the locked-down child and reports the hash of its bundle", async () => {
    const outcome = await call({
      roots: ["openapi.yaml"],
      files: { "openapi.yaml": openapi("  /health:\n    get:\n      responses: { '200': { description: OK } }") },
    });
    const bundleHash = createHash("sha256").update(await readFile(entry)).digest("hex");

    expect(outcome).toMatchObject({
      ok: true,
      output: {
        status: "read",
        readerVersion: bundleHash,
        specs: [{ outcome: "parsed", operations: [{ method: "GET", path: "/health" }] }],
      },
    });
  });

  test("refuses input that is not the job contract", async () => {
    await expect(call({ roots: ["../escape.yaml"], files: { "../escape.yaml": "x" } })).resolves.toEqual({
      ok: false,
      error: { code: "invalid_input", message: "The input has an invalid file." },
    });
  });
});
