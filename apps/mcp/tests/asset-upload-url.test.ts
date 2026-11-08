import { AGENT_ASSET_UPLOAD_LIMITS, DOCS_ASSET_LIMITS } from "@doxahq/contracts/docs-assets";
import { describe, expect, it } from "vitest";
import { handleAssetUpload } from "../src/asset-upload-endpoint";
import type { McpEnv } from "../src/mcp-env";
import {
  assetUploadServices,
  createFakeAssetUploads,
  UPLOAD_ORIGIN,
  type FakeAssetUploads,
} from "./support/fake-asset-uploads";
import {
  BRANCH_ID,
  CLIENT_ID,
  OWNER,
  PROJECT_A,
  PROJECT_B,
  USER_BRANCH_ID,
} from "./support/fixtures";
import { createHarness } from "./support/harness";
import { callTool, toolError } from "./support/tool-calls";

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array<number>(24).fill(0)]);
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const MAX_OPEN = AGENT_ASSET_UPLOAD_LIMITS.maxOpenPerConnection;

interface Ticket {
  uploadId: string;
  uploadUrl: string;
  method: string;
  headers: { Authorization: string };
  maxBytes: number;
  expiresAt: string;
  curl: string;
}

/** Where a PUT goes and the Authorization value it sends. */
interface Target {
  uploadUrl: string;
  authorization: string | null;
}

function setup() {
  const fake = createFakeAssetUploads();
  const harness = createHarness({
    services: (fakes) => ({ ...fakes, assetUploads: assetUploadServices(fake) }),
  });
  return { fake, harness };
}

async function createTicket(
  harness: ReturnType<typeof createHarness>,
  args: Record<string, unknown> = {},
  mode: "modern" | "legacy" = "modern",
) {
  const client = await harness.connect(mode);
  const outcome = await callTool(client, "create_asset_upload", {
    projectId: PROJECT_A,
    branch: BRANCH_ID,
    fileName: "Rate limits diagram.png",
    ...args,
  });
  const ticket = outcome.structured as unknown as Ticket;
  const target: Target = { uploadUrl: ticket.uploadUrl, authorization: ticket.headers?.Authorization ?? null };
  return { client, outcome, ticket, target };
}

function put(
  fake: FakeAssetUploads,
  target: Target,
  body: BodyInit | null,
  options: { method?: string; headers?: Record<string, string> } = {},
) {
  const headers = new Headers(options.headers);
  if (target.authorization !== null) headers.set("authorization", target.authorization);
  return handleAssetUpload(
    new Request(target.uploadUrl, { method: options.method ?? "PUT", body, headers }),
    {} as McpEnv,
    fake.uploads,
  );
}

/** A body that records whether anyone read it. highWaterMark 0: no pull until a read. */
function watchedBody() {
  const state = { read: false };
  const body = new ReadableStream(
    {
      pull(controller) {
        state.read = true;
        controller.enqueue(PNG);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

describe("create_asset_upload", () => {
  it("returns a URL without the secret, the Authorization header, and a curl command", async () => {
    const { fake, harness } = setup();
    const { outcome, ticket } = await createTicket(harness);

    expect(outcome.isError).toBe(false);
    expect(ticket).toMatchObject({
      method: "PUT",
      maxBytes: DOCS_ASSET_LIMITS.maxBytes,
      uploadUrl: expect.stringMatching(/^http:\/\/localhost:8791\/uploads\/[0-9a-f-]{36}$/),
      headers: { Authorization: expect.stringMatching(/^Bearer [A-Za-z0-9_-]{43}$/) },
    });
    expect(ticket.curl).toBe(
      `curl -sS -X PUT -H 'Authorization: ${ticket.headers.Authorization}' --data-binary @FILE '${ticket.uploadUrl}'`,
    );
    expect(Date.parse(ticket.expiresAt) - Date.now()).toBeLessThanOrEqual(AGENT_ASSET_UPLOAD_LIMITS.ttlSeconds * 1000);
    // The collector entry exists before the ticket.
    expect(fake.registered).toEqual([{ uploadId: ticket.uploadId }]);
  });

  it("stores only the hash of the secret", async () => {
    const { fake, harness } = setup();
    const { ticket } = await createTicket(harness);
    const secret = ticket.headers.Authorization.replace("Bearer ", "");
    const text = (await (await fake.bucket.get(`agent-uploads/${ticket.uploadId}/ticket.json`))?.text()) ?? "";
    expect(text).toContain(ticket.uploadId);
    expect(text).not.toContain(secret);
  });

  it("refuses a branch this connection did not create", async () => {
    const { fake, harness } = setup();
    const { outcome } = await createTicket(harness, { branch: USER_BRANCH_ID });
    expect(toolError(outcome).code).toBe("branch_not_found");
    expect(fake.registered).toEqual([]);
  });

  it("never writes to main", async () => {
    const { harness } = setup();
    const { outcome } = await createTicket(harness, { branch: "main" });
    expect(toolError(outcome)).toMatchObject({ code: "invalid", hint: expect.stringMatching(/create_branch/) });
  });

  it("counts against the expensive rate limit", async () => {
    const { harness } = setup();
    await createTicket(harness);
    expect(harness.limiterCalls).toEqual(["expensive"]);
  });

  it(`refuses a new URL while the connection holds ${MAX_OPEN} open ones`, async () => {
    const { harness } = setup();
    for (let index = 0; index < MAX_OPEN; index++) {
      expect((await createTicket(harness)).outcome.isError).toBe(false);
    }
    const { outcome } = await createTicket(harness);
    expect(toolError(outcome)).toMatchObject({
      code: "asset_upload_limit_reached",
      hint: expect.stringMatching(/finish_asset_upload/),
      details: { scope: "connection", maxOpenUploads: MAX_OPEN, retryAfterSeconds: expect.any(Number) },
    });
  });

  it("frees a slot when an upload finishes", async () => {
    const { fake, harness } = setup();
    const targets: Array<{ ticket: Ticket; target: Target }> = [];
    for (let index = 0; index < MAX_OPEN; index++) targets.push(await createTicket(harness));
    const [first] = targets;
    if (!first) throw new Error("No ticket.");
    await put(fake, first.target, PNG);
    const client = await harness.connect("modern");
    await callTool(client, "finish_asset_upload", { projectId: PROJECT_A, uploadId: first.ticket.uploadId });

    expect((await createTicket(harness)).outcome.isError).toBe(false);
  });

  it("needs the docs:write scope", async () => {
    const harness = createHarness({ scopes: ["docs:read"] });
    const { outcome } = await createTicket(harness, {}, "legacy");
    expect(toolError(outcome).code).toBe("insufficient_scope");
  });
});

describe("upload URL", () => {
  it("stages the file and answers with the next step", async () => {
    const { fake, harness } = setup();
    const { ticket, target } = await createTicket(harness);

    const response = await put(fake, target, PNG);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      uploadId: ticket.uploadId,
      size: PNG.byteLength,
      next: expect.stringContaining("finish_asset_upload"),
    });
  });

  it("accepts one file per URL", async () => {
    const { fake, harness } = setup();
    const { target } = await createTicket(harness);
    await put(fake, target, PNG);
    expect((await put(fake, target, PNG)).status).toBe(409);
  });

  it.each([
    ["no header", null, 401],
    ["another scheme", "Basic dXNlcjpwYXNz", 401],
    ["a short secret", "Bearer abc", 401],
    ["the secret in the wrong case of scheme", "bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 401],
    ["a wrong secret", `Bearer ${"A".repeat(43)}`, 404],
  ])("refuses %s without reading the body", async (_name, authorization, status) => {
    const { fake, harness } = setup();
    const { ticket } = await createTicket(harness);
    const { body, state } = watchedBody();
    const headers = new Headers(authorization === null ? {} : { authorization });
    const response = await handleAssetUpload(
      new Request(ticket.uploadUrl, { method: "PUT", body, headers, duplex: "half" } as RequestInit),
      {} as McpEnv,
      fake.uploads,
    );
    expect(response.status).toBe(status);
    expect(state.read).toBe(false);
  });

  it("refuses the right secret on another upload", async () => {
    const { fake, harness } = setup();
    const first = await createTicket(harness);
    const second = await createTicket(harness);
    const response = await put(fake, { uploadUrl: second.ticket.uploadUrl, authorization: first.target.authorization }, PNG);
    expect(response.status).toBe(404);
  });

  it("ignores a secret sent in the path", async () => {
    const { fake, harness } = setup();
    const { ticket, target } = await createTicket(harness);
    const secret = ticket.headers.Authorization.replace("Bearer ", "");
    const response = await put(fake, { uploadUrl: `${target.uploadUrl}/${secret}`, authorization: null }, PNG);
    expect(response.status).toBe(404);
  });

  it("refuses a file over the image limit and stays usable", async () => {
    const { fake, harness } = setup();
    const { target } = await createTicket(harness);
    expect((await put(fake, target, new Uint8Array(DOCS_ASSET_LIMITS.maxBytes + 1))).status).toBe(413);
    expect((await put(fake, target, PNG)).status).toBe(200);
  });

  it("answers 415 for a file that is not an image and stores nothing", async () => {
    const { fake, harness } = setup();
    const { ticket, target } = await createTicket(harness);

    const response = await put(fake, target, EXE);
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: "not_an_image" });
    const staged = await fake.bucket.list({ prefix: `agent-uploads/${ticket.uploadId}/` });
    expect(staged.objects.map((object) => object.key)).toEqual([`agent-uploads/${ticket.uploadId}/ticket.json`]);
  });

  it("closes after repeated refused files", async () => {
    const { fake, harness } = setup();
    const { target } = await createTicket(harness);
    for (let index = 0; index < AGENT_ASSET_UPLOAD_LIMITS.maxFailedAttempts; index++) {
      expect((await put(fake, target, EXE)).status).toBe(415);
    }
    const closed = await put(fake, target, PNG);
    expect(closed.status).toBe(410);
    expect(await closed.json()).toMatchObject({ error: "closed" });
  });

  it("refuses an empty body", async () => {
    const { fake, harness } = setup();
    const { target } = await createTicket(harness);
    expect((await put(fake, target, null)).status).toBe(400);
  });

  it("answers 410 after the URL expired", async () => {
    const { fake, harness } = setup();
    const { target } = await createTicket(harness);
    fake.advance(AGENT_ASSET_UPLOAD_LIMITS.ttlSeconds * 1000 + 1);
    expect((await put(fake, target, PNG)).status).toBe(410);
  });

  it.each(["GET", "HEAD", "POST", "DELETE", "OPTIONS"])("refuses %s", async (method) => {
    const { fake, harness } = setup();
    const { target } = await createTicket(harness);
    const response = await put(fake, target, null, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("PUT");
  });

  it.each([
    "/uploads/nope",
    "/uploads/",
    "/uploads/11111111-1111-4111-8111-111111111111/extra",
    "/uploads/11111111-1111-4111-8111-11111111111G",
  ])("answers 404 for the path %s", async (path) => {
    const { fake } = setup();
    expect((await put(fake, { uploadUrl: `${UPLOAD_ORIGIN}${path}`, authorization: `Bearer ${"A".repeat(43)}` }, PNG)).status).toBe(404);
  });
});

describe("finish_asset_upload", () => {
  it("adds the staged file to the branch and removes the staging", async () => {
    const { fake, harness } = setup();
    const { client, ticket, target } = await createTicket(harness);
    await put(fake, target, PNG);

    const outcome = await callTool(client, "finish_asset_upload", {
      projectId: PROJECT_A,
      uploadId: ticket.uploadId,
      altText: "Rate limits",
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.structured).toEqual({
      path: "/assets/rate-limits-diagram.png",
      markdown: "![Rate limits](/assets/rate-limits-diagram.png)",
      contentType: "image/png",
      size: PNG.byteLength,
      sanitized: false,
      reused: false,
      revision: 3,
    });
    expect(harness.calls).toContainEqual(
      expect.objectContaining({ method: "branches.uploadAsset", userId: OWNER, projectId: PROJECT_A }),
    );
    expect(await fake.bucket.list({ prefix: `agent-uploads/${ticket.uploadId}/` })).toMatchObject({ objects: [] });
    expect(await fake.bucket.list({ prefix: "agent-upload-index/" })).toMatchObject({ objects: [] });

    // The upload finished, so the same ID cannot add the file again.
    const again = await callTool(client, "finish_asset_upload", { projectId: PROJECT_A, uploadId: ticket.uploadId });
    expect(toolError(again).code).toBe("asset_upload_not_found");
  });

  it("asks for the PUT when no file arrived", async () => {
    const { harness } = setup();
    const { client, ticket } = await createTicket(harness);
    const outcome = await callTool(client, "finish_asset_upload", { projectId: PROJECT_A, uploadId: ticket.uploadId });
    expect(toolError(outcome)).toMatchObject({ code: "asset_upload_not_sent", hint: expect.stringMatching(/PUT/) });
  });

  it("refuses an upload of another project", async () => {
    const { fake, harness } = setup();
    const { client, ticket, target } = await createTicket(harness);
    await put(fake, target, PNG);
    const outcome = await callTool(client, "finish_asset_upload", { projectId: PROJECT_B, uploadId: ticket.uploadId });
    expect(toolError(outcome).code).toBe("asset_upload_not_found");
  });

  it("refuses an upload that another connection created", async () => {
    const { fake, harness } = setup();
    const created = await fake.uploads.create({
      ownerUserId: OWNER,
      projectId: PROJECT_A,
      branchId: BRANCH_ID,
      agent: { userId: OWNER, clientId: `${CLIENT_ID}-other` },
      fileName: "a.png",
    });
    await put(fake, { uploadUrl: `${UPLOAD_ORIGIN}/uploads/${created.uploadId}`, authorization: `Bearer ${created.secret}` }, PNG);
    const client = await harness.connect("modern");
    const outcome = await callTool(client, "finish_asset_upload", { projectId: PROJECT_A, uploadId: created.uploadId });
    expect(toolError(outcome).code).toBe("asset_upload_not_found");
    expect(harness.calls.map((call) => call.method)).not.toContain("branches.uploadAsset");
  });

  it("refuses an expired upload", async () => {
    const { fake, harness } = setup();
    const { client, ticket, target } = await createTicket(harness);
    await put(fake, target, PNG);
    fake.advance(AGENT_ASSET_UPLOAD_LIMITS.ttlSeconds * 1000 + 1);
    const outcome = await callTool(client, "finish_asset_upload", { projectId: PROJECT_A, uploadId: ticket.uploadId });
    expect(toolError(outcome).code).toBe("asset_upload_not_found");
  });

  it("rejects a malformed upload ID at the schema", async () => {
    const { harness } = setup();
    const client = await harness.connect("modern");
    const outcome = await callTool(client, "finish_asset_upload", { projectId: PROJECT_A, uploadId: "../../sites/x" });
    expect(outcome.isError).toBe(true);
    expect(harness.calls.map((call) => call.method)).not.toContain("branches.uploadAsset");
  });

  it("reports a cleaned SVG", async () => {
    const { fake, harness } = setup();
    const { client, ticket, target } = await createTicket(harness, { fileName: "flow.svg" });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path d="M0 0"/></svg>';
    expect((await put(fake, target, svg)).status).toBe(200);
    const outcome = await callTool(client, "finish_asset_upload", { projectId: PROJECT_A, uploadId: ticket.uploadId });
    expect(outcome.structured).toMatchObject({ path: "/assets/flow.svg", contentType: "image/svg+xml", sanitized: true });
  });

  it("counts against the expensive rate limit", async () => {
    const { fake, harness } = setup();
    const { client, ticket, target } = await createTicket(harness);
    await put(fake, target, PNG);
    await callTool(client, "finish_asset_upload", { projectId: PROJECT_A, uploadId: ticket.uploadId });
    expect(harness.limiterCalls).toEqual(["expensive", "expensive"]);
  });
});
