import { beforeEach, describe, expect, test, vi } from "vitest";
import { DOCS_ASSET_LIMITS } from "@doxahq/contracts/docs-assets";
import { createApiRouter } from "../../src/http/app";

const mocks = vi.hoisted(() => ({ upload: vi.fn(), read: vi.fn() }));
vi.mock("../../src/services/agent-access/project-access-repository", async () => {
  const { SessionOwnedProjectAccess } = await import("../support/session-owned-project-access");
  return { ProjectAccessRepository: SessionOwnedProjectAccess };
});
vi.mock("../../src/http/auth", () => ({
  withUser: (
    _context: unknown,
    handler: (userId: string) => Promise<Response>,
  ) => handler("owner"),
}));
vi.mock("../../src/services/docs-branches/assets/asset-upload", () => ({
  DocsBranchAssetUpload: { fromEnv: () => ({ upload: mocks.upload }) },
}));
vi.mock("../../src/services/docs-branches/assets/asset-read", () => ({
  DocsBranchAssetRead: { fromEnv: () => ({ read: mocks.read }) },
}));

import { createDocsBranchRoutes } from "../../src/routes/docs-branches";
import { DocsContentError } from "../../src/services/docs-content/errors";

const projectId = "11111111-1111-4111-8111-111111111111";

function request(path: string, init?: RequestInit) {
  const app = createApiRouter();
  app.route("/projects/:projectId/branches", createDocsBranchRoutes());
  return app.request(
    `http://localhost/projects/${projectId}/branches${path}`,
    init,
  );
}

function upload(form: FormData, path = "/main/assets") {
  return request(path, { method: "POST", body: form });
}

function imageForm(bytes = new Uint8Array([1, 2, 3])) {
  const form = new FormData();
  form.set("file", new File([bytes], "Screen Shot.png", { type: "image/png" }));
  return form;
}

describe("branch image routes", () => {
  beforeEach(() => {
    mocks.upload.mockReset();
    mocks.read.mockReset();
  });

  test("uploads one image as the editor", async () => {
    const result = {
      path: "/assets/screen-shot.png",
      contentType: "image/png",
      size: 3,
      sanitized: false,
      reused: false,
      revision: 1,
    };
    mocks.upload.mockResolvedValue(result);

    const response = await upload(imageForm());

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(result);
    expect(mocks.upload).toHaveBeenCalledWith({
      userId: "owner",
      projectId,
      branch: "main",
      origin: "editor",
      fileName: "Screen Shot.png",
      bytes: new Uint8Array([1, 2, 3]),
    });
  });

  test("rejects a body without exactly one file", async () => {
    const extra = imageForm();
    extra.set("kind", "logo");
    expect((await upload(extra)).status).toBe(400);
    expect((await upload(new FormData())).status).toBe(400);
    expect(
      (await request("/main/assets", { method: "POST", body: "raw" })).status,
    ).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  test("rejects a file over the size limit before the service", async () => {
    const size = DOCS_ASSET_LIMITS.maxBytes + 128 * 1024;
    const response = await request("/main/assets", {
      method: "POST",
      body: new Uint8Array(size),
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(size),
      },
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { details: { code: "asset_too_large" } },
    });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  test("passes service errors through with their code", async () => {
    mocks.upload.mockRejectedValue(
      new DocsContentError("asset_limit_reached", "Too many images.", {
        maxFiles: 50,
      }),
    );

    const response = await upload(imageForm());

    expect(await response.json()).toMatchObject({
      error: { details: { code: "asset_limit_reached", maxFiles: 50 } },
    });
  });

  test("answers 404 for an invalid branch ref", async () => {
    expect((await upload(imageForm(), "/not-a-branch/assets")).status).toBe(404);
  });

  test("reads an image of the branch without a shared cache", async () => {
    mocks.read.mockResolvedValue({
      bytes: new Uint8Array([9, 8]),
      contentType: "image/png",
    });

    const response = await request("/main/assets/diagram.png");

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([9, 8]),
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.read).toHaveBeenCalledWith({
      userId: "owner",
      projectId,
      branch: "main",
      name: "diagram.png",
    });
  });

  test("sandboxes an SVG image", async () => {
    mocks.read.mockResolvedValue({
      bytes: new TextEncoder().encode("<svg/>"),
      contentType: "image/svg+xml",
    });

    const response = await request("/main/assets/flow.svg");

    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  });

  test("answers 404 for an invalid name or a missing image", async () => {
    expect((await request("/main/assets/..%2Fmanifest.json")).status).toBe(404);
    expect((await request("/main/assets/Diagram.PNG")).status).toBe(404);
    expect(mocks.read).not.toHaveBeenCalled();

    mocks.read.mockResolvedValue(null);
    expect((await request("/main/assets/missing.png")).status).toBe(404);
  });
});
