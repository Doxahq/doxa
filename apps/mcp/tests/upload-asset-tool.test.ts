import { describe, expect, it } from "vitest";
import { DOCS_ASSET_LIMITS } from "@doxahq/contracts/docs-assets";
import { MAX_MCP_BODY_BYTES } from "../src/request-body";
import { BRANCH_ID, OWNER, PROJECT_A } from "./support/fixtures";
import { createHarness } from "./support/harness";
import { callTool, toolError } from "./support/tool-calls";

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

const PNG = Uint8Array.from([
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
  ...new Array<number>(24).fill(0),
]);
const SVG_WITH_SCRIPT =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path d="M0 0"/></svg>';

async function run(args: Record<string, unknown>) {
  const harness = createHarness();
  const client = await harness.connect("modern");
  const outcome = await callTool(client, "upload_asset", {
    projectId: PROJECT_A,
    branch: BRANCH_ID,
    fileName: "Rate limits diagram.png",
    contentBase64: base64(PNG),
    ...args,
  });
  return { harness, outcome };
}

describe("upload_asset", () => {
  it("uploads to the branch as the owner and returns the MDX path", async () => {
    const { harness, outcome } = await run({ altText: "Rate [limits]\nflow" });

    expect(outcome.isError).toBe(false);
    expect(outcome.structured).toEqual({
      path: "/assets/rate-limits-diagram.png",
      markdown: "![Rate limits flow](/assets/rate-limits-diagram.png)",
      contentType: "image/png",
      size: PNG.byteLength,
      sanitized: false,
      reused: false,
      revision: 3,
    });
    expect(harness.calls).toContainEqual(
      expect.objectContaining({
        method: "branches.uploadAsset",
        userId: OWNER,
        projectId: PROJECT_A,
      }),
    );
  });

  it("counts against the expensive rate limit", async () => {
    const { harness } = await run({});
    expect(harness.limiterCalls).toEqual(["expensive"]);
  });

  it("reports a cleaned SVG", async () => {
    const { outcome } = await run({
      fileName: "flow.svg",
      contentBase64: btoa(SVG_WITH_SCRIPT),
    });
    expect(outcome.structured).toMatchObject({
      path: "/assets/flow.svg",
      contentType: "image/svg+xml",
      sanitized: true,
    });
  });

  it("rejects a spoofed image with asset_invalid and a hint", async () => {
    const { outcome } = await run({ contentBase64: btoa("not an image") });
    expect(toolError(outcome)).toMatchObject({
      code: "asset_invalid",
      hint: expect.stringMatching(/PNG, JPEG, WebP, GIF, or SVG/),
    });
  });

  it("rejects invalid base64 before the service", async () => {
    const { harness, outcome } = await run({ contentBase64: "%%%%" });
    expect(toolError(outcome).code).toBe("asset_invalid");
    expect(harness.calls).toEqual([]);
  });

  it("never writes to main", async () => {
    const { harness, outcome } = await run({ branch: "main" });
    expect(toolError(outcome)).toMatchObject({
      code: "invalid",
      hint: expect.stringMatching(/create_branch/),
    });
    expect(harness.calls).toEqual([]);
  });

  it("needs the docs:write scope", async () => {
    const harness = createHarness({ scopes: ["docs:read"] });
    const client = await harness.connect("legacy");
    const outcome = await callTool(client, "upload_asset", {
      projectId: PROJECT_A,
      branch: BRANCH_ID,
      fileName: "a.png",
      contentBase64: base64(PNG),
    });
    expect(toolError(outcome).code).toBe("insufficient_scope");
    expect(harness.calls).toEqual([]);
  });

  it("accepts a request body that carries the largest image", () => {
    const largestCall =
      Math.ceil(DOCS_ASSET_LIMITS.maxBytes / 3) * 4 + 64 * 1024;
    expect(MAX_MCP_BODY_BYTES).toBeGreaterThan(largestCall);
  });
});
