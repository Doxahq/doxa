import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { GrantsService, MAX_LISTED_GRANTS } = await import(
  "../../../src/services/oauth/grants-service"
);
const { noAgentActivity } = await import("../../../src/services/oauth/agent-activity-lookup");
const { GRANT_REF, OWNER, PROJECT_A, fakeOAuthApi, grantSummary } = await import("./fixtures");

describe("GrantsService.list", () => {
  it("maps grants to summaries from their metadata", async () => {
    const oauth = fakeOAuthApi({
      listUserGrants: async () => ({
        items: [
          grantSummary({
            metadata: {
              clientName: "Cursor",
              cimd: true,
              grantRef: GRANT_REF,
              projectScope: { kind: "selected", projectIds: [PROJECT_A] },
            },
          }),
        ],
      }),
    });
    const lastActivity = new Date("2026-10-04T13:00:00.000Z");
    const service = new GrantsService({
      oauth,
      activity: { lastActivityByGrantRef: async () => new Map([[GRANT_REF, lastActivity]]) },
    });

    expect(await service.list(OWNER)).toEqual([
      {
        grantId: "grant-1",
        clientName: "Cursor",
        scopes: ["docs:read"],
        projectScope: { kind: "selected", projectIds: [PROJECT_A] },
        createdAt: "2026-10-04T12:00:00.000Z",
        lastActivityAt: "2026-10-04T13:00:00.000Z",
      },
    ]);
  });

  it("follows cursors, skips grants it cannot describe, and sorts newest first", async () => {
    const oauth = fakeOAuthApi();
    oauth.listUserGrants
      .mockResolvedValueOnce({
        items: [grantSummary({ id: "old", createdAt: 100 })],
        cursor: "page-2",
      })
      .mockResolvedValueOnce({
        items: [grantSummary({ id: "foreign", metadata: {} }), grantSummary({ id: "new", createdAt: 200 })],
      });
    const service = new GrantsService({ oauth, activity: noAgentActivity });

    const grants = await service.list(OWNER);

    expect(grants.map((grant) => grant.grantId)).toEqual(["new", "old"]);
    expect(grants[0].lastActivityAt).toBeNull();
    expect(oauth.listUserGrants).toHaveBeenNthCalledWith(2, OWNER, { limit: 100, cursor: "page-2" });
  });

  it("caps the list", async () => {
    const oauth = fakeOAuthApi();
    let page = 0;
    oauth.listUserGrants.mockImplementation(async () => {
      page += 1;
      return {
        items: Array.from({ length: 100 }, (_, index) => grantSummary({ id: `g-${page}-${index}` })),
        cursor: `page-${page + 1}`,
      };
    });
    const service = new GrantsService({ oauth, activity: noAgentActivity });

    expect(await service.list(OWNER)).toHaveLength(MAX_LISTED_GRANTS);
  });
});

describe("GrantsService.revoke", () => {
  it("revokes a grant the user holds", async () => {
    const oauth = fakeOAuthApi({ listUserGrants: async () => ({ items: [grantSummary()] }) });
    const service = new GrantsService({ oauth, activity: noAgentActivity });

    expect(await service.revoke(OWNER, "grant-1")).toEqual({ kind: "revoked" });
    expect(oauth.revokeGrant).toHaveBeenCalledWith("grant-1", OWNER);
  });

  it.each([
    ["an unknown grant", "grant-2"],
    ["a malformed grant ID", "grant:1"],
  ])("returns not_found for %s", async (_label, grantId) => {
    const oauth = fakeOAuthApi({ listUserGrants: async () => ({ items: [grantSummary()] }) });
    const service = new GrantsService({ oauth, activity: noAgentActivity });

    expect(await service.revoke(OWNER, grantId)).toEqual({ kind: "not_found" });
    expect(oauth.revokeGrant).not.toHaveBeenCalled();
  });
});
