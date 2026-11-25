import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApiRouter } from "../../src/http/app";
import { createSiteAssetsRoutes } from "../../src/routes/site-assets";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  site: vi.fn(),
  get: vi.fn(),
  head: vi.fn(),
  put: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../../src/services/agent-access/project-access-repository", async () => {
  const { SessionOwnedProjectAccess } = await import("../support/session-owned-project-access");
  return { ProjectAccessRepository: SessionOwnedProjectAccess };
});
vi.mock("@doxahq/auth", () => ({ getSessionUser: mocks.session }));
vi.mock("../../src/repositories/projects", () => ({
  ProjectsRepository: class {
    getDocsSiteForUser = mocks.site;
    withSiteAssetLock = <T>(_siteId: string, work: () => Promise<T>) => work();
  },
}));

function request(form: FormData) {
  const app = createApiRouter();
  app.route("/projects/:projectId/assets", createSiteAssetsRoutes());
  return app.request(
    "https://api.test/projects/11111111-1111-4111-8111-111111111111/assets",
    { method: "POST", body: form },
    { DOCS_BUCKET: { head: mocks.head, get: mocks.get, put: mocks.put, list: mocks.list } },
  );
}
function upload(
  content = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
) {
  const form = new FormData();
  form.set("kind", "logo");
  form.set("file", new File([content], "pretend.png", { type: "image/png" }));
  return form;
}

describe("site asset upload route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.session.mockResolvedValue({ id: "owner" });
    mocks.site.mockResolvedValue({ siteId: "resolved-site" });
    mocks.head.mockResolvedValue(null);
    mocks.list.mockResolvedValue({ objects: [], truncated: false });
  });
  test("refuses a new file when the site is at its limit", async () => {
    mocks.session.mockResolvedValue({ id: "owner" });
    mocks.list.mockResolvedValue({
      objects: Array.from({ length: 200 }, (_, index) => ({ key: `a${index}`, size: 1 })),
      truncated: false,
    });
    const response = await request(upload());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { details: { code: "plan_limit", key: "site.asset_files", limit: 200, used: 200 } },
    });
    expect(mocks.put).not.toHaveBeenCalled();
  });
  test("requires a session", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await request(upload())).status).toBe(401);
    expect(mocks.site).not.toHaveBeenCalled();
  });
  test("requires project ownership", async () => {
    mocks.site.mockResolvedValue(null);
    expect((await request(upload())).status).toBe(404);
    expect(mocks.put).not.toHaveBeenCalled();
  });
  test("ignores the client MIME type", async () => {
    const response = await request(upload());
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      contentType: "image/svg+xml",
      warnings: [expect.objectContaining({ code: "asset_sanitized" })],
    });
    expect(mocks.put).toHaveBeenCalledWith(
      expect.stringMatching(/^sites\/resolved-site\/assets\/[a-f0-9]{64}$/),
      expect.any(Uint8Array),
      {
        httpMetadata: { contentType: "image/svg+xml" },
        customMetadata: { kind: "logo" },
      },
    );
  });
  test("rejects two files", async () => {
    const form = upload();
    form.append("file", new File(["extra"], "extra.svg"));
    expect((await request(form)).status).toBe(400);
    expect(mocks.put).not.toHaveBeenCalled();
  });
  test("rejects unsupported content with a stable issue code", async () => {
    const response = await request(upload("not an image"));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        details: {
          code: "validation_failed",
          issues: [expect.objectContaining({ code: "asset_unsupported_type" })],
        },
      },
    });
  });
});
