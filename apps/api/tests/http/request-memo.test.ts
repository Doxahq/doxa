import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApiRouter } from "../../src/http/app";
import { requestSessionUser, withUser } from "../../src/http/auth";
import { withProjectAccess } from "../../src/http/project-access";
import { json } from "../../src/http/response";
import { InMemoryProjectAccess } from "../support/in-memory-project-access";

const OWNER = "owner-1";
const VIEWER = "viewer-1";
const TEAM = "55555555-5555-4555-8555-555555555555";
const PROJECT = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  access: null as null | InstanceType<
    typeof import("../support/in-memory-project-access").InMemoryProjectAccess
  >,
}));

vi.mock("@doxahq/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("../../src/services/agent-access/project-access-repository", () => ({
  ProjectAccessRepository: vi.fn(() => mocks.access),
}));

const env = { ADMIN_EMAILS: "admin@doxa.so" };

function routes() {
  const app = createApiRouter();
  // Two checks in one request, as a route that reads two sections would do.
  app.get("/projects/:projectId/twice", (context) =>
    withProjectAccess(context, "project.read", () =>
      withProjectAccess(context, "docs.read", async (access) =>
        json({ role: access.role }),
      ),
    ),
  );
  app.get("/projects/:projectId/write", (context) =>
    withProjectAccess(context, "project.read", () =>
      withProjectAccess(context, "docs.write", async () => json({ ok: true })),
    ),
  );
  app.get("/session", (context) =>
    withUser(context, async (userId) => {
      await requestSessionUser(context);
      return json({ userId });
    }),
  );
  return app;
}

let findAccess: { mock: { calls: unknown[] } };

beforeEach(() => {
  mocks.getSessionUser.mockReset();
  mocks.access = new InMemoryProjectAccess(
    { [PROJECT]: { owner: OWNER, teamId: TEAM } },
    { [TEAM]: { [OWNER]: "owner", [VIEWER]: "viewer" } },
  );
  findAccess = vi.spyOn(mocks.access, "findAccess");
});

describe("one session and access check per request", () => {
  test("a request reads the session and the project access once", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: OWNER, email: "owner@doxa.so" });

    const response = await routes().request(`/projects/${PROJECT}/twice`, {}, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ role: "owner" });
    expect(mocks.getSessionUser).toHaveBeenCalledTimes(1);
    expect(findAccess).toHaveBeenCalledTimes(1);
  });

  test("the memo never skips a capability check", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: VIEWER, email: "viewer@doxa.so" });

    const response = await routes().request(`/projects/${PROJECT}/write`, {}, env);

    expect(response.status).toBe(403);
    expect(findAccess).toHaveBeenCalledTimes(1);
  });

  test("each request checks again", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: OWNER, email: "owner@doxa.so" });
    const app = routes();

    await app.request(`/projects/${PROJECT}/twice`, {}, env);
    mocks.access!.leave(TEAM, OWNER);
    const second = await app.request(`/projects/${PROJECT}/twice`, {}, env);

    expect(second.status).toBe(404);
    expect(mocks.getSessionUser).toHaveBeenCalledTimes(2);
    expect(findAccess).toHaveBeenCalledTimes(2);
  });

  test("a failed session lookup is not kept for the rest of the request", async () => {
    mocks.getSessionUser
      .mockRejectedValueOnce(new Error("session store down"))
      .mockResolvedValue({ id: OWNER });
    const app = createApiRouter();
    app.get("/retry", async (context) => {
      await expect(requestSessionUser(context)).rejects.toThrow("session store down");
      const user = await requestSessionUser(context);
      return json({ userId: user?.id });
    });

    const response = await app.request("/retry", {}, env);

    expect(await response.json()).toEqual({ userId: OWNER });
    expect(mocks.getSessionUser).toHaveBeenCalledTimes(2);
  });

  test("withUser and a later lookup share one session read", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: OWNER });

    const response = await routes().request("/session", {}, env);

    expect(await response.json()).toEqual({ userId: OWNER });
    expect(mocks.getSessionUser).toHaveBeenCalledTimes(1);
  });

  test("no session answers 401", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await routes().request(`/projects/${PROJECT}/twice`, {}, env);

    expect(response.status).toBe(401);
    expect(findAccess).not.toHaveBeenCalled();
  });
});
