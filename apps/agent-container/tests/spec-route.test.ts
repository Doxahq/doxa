import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRepositorySpecs } from "@doxahq/agent";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { RUN_ID_HEADER } from "../src/utility/gate";
import {
  createGateSpecReaderClient,
  createLocalSpecReaderClient,
  resolveSpecReaderClient,
  resolveUtilityMode,
} from "../src/utility/spec-reader-client";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const jobDirectory = fileURLToPath(new URL("../../utility-jobs/spec-reader/", import.meta.url));
const bundle = join(jobDirectory, "dist/job.mjs");
const directories: string[] = [];

beforeAll(() => {
  execFileSync(process.execPath, ["build.mjs"], { cwd: jobDirectory });
}, 60_000);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function checkout(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doxa-spec-route-"));
  directories.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe("spec route with the real job bundle", () => {
  test("reads a spec and its referenced file through rounds in the locked-down child", async () => {
    const root = await checkout({
      "api/openapi.yaml": [
        "openapi: 3.1.0",
        "info: { title: Shop API, version: '1', description: 'Sell <script>alert(1)</script> things.' }",
        "servers: [{ url: https://api.shop.example/v1 }]",
        "tags: [{ name: orders, description: Manage orders. }]",
        "paths:",
        "  /orders/{orderId}:",
        "    get:",
        "      tags: [orders]",
        "      summary: Get an order",
        "      responses:",
        "        '200':",
        "          description: The order",
        "          content:",
        "            application/json:",
        "              schema: { $ref: './schemas/order.yaml#/Order' }",
      ].join("\n"),
      "api/schemas/order.yaml": "Order:\n  type: object\n  required: [id]\n  properties:\n    id: { type: string }\n",
    });

    const result = await readRepositorySpecs({ checkoutRoot: root, client: createLocalSpecReaderClient(bundle) });

    expect(result.report).toMatchObject({ status: "openapi", operationCount: 1, skippedOperationCount: 0 });
    expect(result.surface).toMatchObject({
      source: { kind: "openapi", files: ["api/openapi.yaml", "api/schemas/order.yaml"] },
      baseUrl: "https://api.shop.example/v1",
      groups: [{
        id: "orders",
        endpoints: [{
          id: "get-orders-order-id",
          title: "Get an order",
          responses: [{ status: 200, fields: [{ name: "id", type: "string", required: true }] }],
        }],
      }],
    });
    expect(result.surface?.description).not.toContain("<script>");
  });
});

describe("spec reader clients", () => {
  test("calls the gate with the run ID and reads the job outcome", async () => {
    const requests: Request[] = [];
    const client = createGateSpecReaderClient(RUN_ID, async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response(JSON.stringify({ ok: true, output: { status: "need_files", needFiles: ["a.yaml"] } }));
    });

    await expect(client.read({ roots: ["openapi.yaml"], files: { "openapi.yaml": "openapi: 3.1.0\n" } })).resolves.toEqual({
      ok: true,
      output: { status: "need_files", needFiles: ["a.yaml"] },
    });
    await client.done();

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/jobs/spec-reader/run",
      "/v1/jobs/spec-reader/done",
    ]);
    expect(requests.every((request) => request.headers.get(RUN_ID_HEADER) === RUN_ID)).toBe(true);
  });

  test("reports a gate refusal as a failed call", async () => {
    const client = createGateSpecReaderClient(RUN_ID, async () => new Response(null, { status: 404 }));

    await expect(client.read({ roots: ["a.yaml"], files: { "a.yaml": "x" } })).resolves.toEqual({
      ok: false,
      code: "gate_404",
      message: "The gate answered 404.",
    });
  });

  test("picks the client from DOXA_UTILITY_MODE", () => {
    expect(resolveUtilityMode(undefined)).toBe("container");
    expect(resolveUtilityMode("local")).toBe("local");
    expect(resolveUtilityMode("docker")).toBe("docker");
    expect(resolveSpecReaderClient(RUN_ID, { DOXA_UTILITY_MODE: "docker" })).toBeDefined();
    expect(resolveUtilityMode("anything")).toBe("container");
    expect(resolveSpecReaderClient(RUN_ID, { DOXA_UTILITY_MODE: "off" })).toBeUndefined();
    expect(resolveSpecReaderClient(RUN_ID, { DOXA_UTILITY_MODE: "local", DOXA_SPEC_READER_BUNDLE: "/missing/job.mjs" }))
      .toBeUndefined();
    expect(resolveSpecReaderClient(RUN_ID, { DOXA_UTILITY_MODE: "local" })).toBeDefined();
  });
});
