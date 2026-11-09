import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { GrantsService, MAX_LISTED_GRANTS } = await import(
  "../../../src/services/oauth/grants-service"
);
const { noAgentActivity } = await import("../../../src/services/oauth/agent-activity-lookup");
const { GRANT_REF, NOW, OWNER, PROJECT_A, agentTokenDeps, fakeOAuthApi, grantSummary } = await import("./fixtures");

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
      activity: { lastActivityByGrantRef: async () => new Map([[GRANT_REF, lastActivity]]) }, ...agentTokenDeps });

    expect(await service.list(OWNER)).toEqual([
      {
        grantId: "grant-1",
        clientName: "Cursor",
        scopes: ["docs:read"],
        projectScope: { kind: "selected", projectIds: [PROJECT_A] },
        createdAt: "2026-10-04T12:00:00.000Z",
        lastActivityAt: "2026-10-04T13:00:00.000Z",
        expiresAt: null,
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
    const service = new GrantsService({ oauth, activity: noAgentActivity, ...agentTokenDeps });

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
    const service = new GrantsService({ oauth, activity: noAgentActivity, ...agentTokenDeps });

    expect(await service.list(OWNER)).toHaveLength(MAX_LISTED_GRANTS);
  });
});

describe("GrantsService.revoke", () => {
  it("revokes a grant the user holds", async () => {
    const oauth = fakeOAuthApi({ listUserGrants: async () => ({ items: [grantSummary()] }) });
    const service = new GrantsService({ oauth, activity: noAgentActivity, ...agentTokenDeps });

    expect(await service.revoke(OWNER, "grant-1")).toEqual({ kind: "revoked" });
    expect(oauth.revokeGrant).toHaveBeenCalledWith("grant-1", OWNER);
  });

  it.each([
    ["an unknown grant", "grant-2"],
    ["a malformed grant ID", "grant:1"],
  ])("returns not_found for %s", async (_label, grantId) => {
    const oauth = fakeOAuthApi({ listUserGrants: async () => ({ items: [grantSummary()] }) });
    const service = new GrantsService({ oauth, activity: noAgentActivity, ...agentTokenDeps });

    expect(await service.revoke(OWNER, grantId)).toEqual({ kind: "not_found" });
    expect(oauth.revokeGrant).not.toHaveBeenCalled();
  });
});

describe("GrantsService with agent tokens", () => {
  const tokenId = "55555555-5555-4555-8555-555555555555";
  const record = {
    id: tokenId,
    userId: OWNER,
    tokenHash: "hash",
    tokenName: "Acme docs",
    clientName: "Claude Code",
    scopes: ["docs:read", "not-a-scope"],
    projectScope: { kind: "all" },
    grantRef: GRANT_REF,
    createdAt: new Date("2026-10-05T12:00:00.000Z"),
    lastUsedAt: null,
    expiresAt: new Date("2027-01-03T12:00:00.000Z"),
    revokedAt: null,
  };

  function serviceWith(agentTokens: { listActive: () => Promise<(typeof record)[]>; revoke: (userId: string, id: string) => Promise<boolean> }) {
    return new GrantsService({
      oauth: fakeOAuthApi({ listUserGrants: async () => ({ items: [] }) }),
      activity: noAgentActivity,
      agentTokens,
      now: () => NOW,
    });
  }

  it("lists a token with its label, known scopes, and end date", async () => {
    const service = serviceWith({ listActive: async () => [record], revoke: async () => false });
    expect(await service.list(OWNER)).toEqual([
      {
        grantId: `agent-token-${tokenId}`,
        clientName: "Acme docs",
        scopes: ["docs:read"],
        projectScope: { kind: "all" },
        createdAt: "2026-10-05T12:00:00.000Z",
        lastActivityAt: null,
        expiresAt: "2026-11-04T12:00:00.000Z",
      },
    ]);
  });

  it("lists the fixed end date when it comes before the idle limit", async () => {
    const lastUsedAt = new Date("2026-12-30T12:00:00.000Z");
    const service = serviceWith({ listActive: async () => [{ ...record, lastUsedAt } as never], revoke: async () => false });
    const [summary] = await service.list(OWNER);
    expect(summary?.expiresAt).toBe("2027-01-03T12:00:00.000Z");
  });

  it("skips a token whose stored project scope is not valid", async () => {
    const service = serviceWith({
      listActive: async () => [{ ...record, projectScope: { kind: "everything" } as never }],
      revoke: async () => false,
    });
    expect(await service.list(OWNER)).toEqual([]);
  });

  it("revokes a token for its owner only, and never sends a malformed ID to storage", async () => {
    const revoke = vi.fn(async (_userId: string, id: string) => id === tokenId);
    const service = serviceWith({ listActive: async () => [], revoke });

    expect(await service.revoke(OWNER, `agent-token-${tokenId}`)).toEqual({ kind: "revoked" });
    expect(revoke).toHaveBeenCalledWith(OWNER, tokenId, NOW);
    expect(await service.revoke(OWNER, "agent-token-'; DROP TABLE x;--")).toEqual({ kind: "not_found" });
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
