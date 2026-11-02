import { beforeEach, describe, expect, it, vi } from "vitest";
import { OAUTH_SCOPES, agentGrantPropsSchema } from "@doxahq/contracts/agent-access";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const {
  CONSENT_ID,
  GRANT_REF,
  ISSUER,
  MemoryConsentStore,
  NOW,
  OTHER,
  OTHER_PROJECT,
  OWNER,
  PROJECT_A,
  PROJECT_B,
  authRequest,
  consentService,
  fakeOAuthApi,
  pendingConsent,
} = await import("./fixtures");
const { agentGrantMetadataSchema } = await import("../../../src/services/oauth/grant-metadata");
const { membershipPolicy } = await import("../../support/in-memory-project-access");

let store: InstanceType<typeof MemoryConsentStore>;
let oauth: ReturnType<typeof fakeOAuthApi>;

beforeEach(() => {
  store = new MemoryConsentStore();
  oauth = fakeOAuthApi();
});

const approveAll = { scopes: ["docs:read" as const], projectScope: { kind: "all" as const } };

describe("ConsentService.get", () => {
  it("describes the client, the offered scopes, and the user's projects", async () => {
    await store.save(CONSENT_ID, pendingConsent());

    const result = await consentService(store).get(CONSENT_ID, OWNER);

    expect(result).toEqual({
      kind: "found",
      details: {
        consentId: CONSENT_ID,
        client: {
          name: "Claude Code",
          metadataUrl: null,
          verified: false,
          redirectHost: "127.0.0.1:9999",
        },
        requestedScopes: ["docs:read", "docs:write"],
        projects: [
          { id: PROJECT_A, name: "Project 1111", slug: "project-1111", team: null },
          { id: PROJECT_B, name: "Project 2222", slug: "project-2222", team: null },
        ],
        expiresAt: "2026-10-04T12:10:00.000Z",
      },
    });
  });

  it("lists the team projects the user can access, with their team (spec §5)", async () => {
    await store.save(CONSENT_ID, pendingConsent());
    const teamId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const projects = membershipPolicy(
      {
        [PROJECT_A]: { owner: OWNER },
        [PROJECT_B]: { owner: OTHER, teamId },
        [OTHER_PROJECT]: { owner: OTHER },
      },
      { [teamId]: { [OTHER]: "owner", [OWNER]: "viewer" } },
    );
    const result = await consentService(store, fakeOAuthApi(), () => NOW, projects).get(CONSENT_ID, OWNER);
    if (result.kind !== "found") throw new Error("expected the consent");
    expect(result.details.projects.map(({ id, team }) => ({ id, teamId: team?.id ?? null }))).toEqual([
      { id: PROJECT_A, teamId: null },
      { id: PROJECT_B, teamId },
    ]);
    // A team project the user can read is a valid pick for a selected grant.
    const approved = await consentService(store, fakeOAuthApi(), () => NOW, projects).approve(CONSENT_ID, OWNER, {
      scopes: ["docs:read"],
      projectScope: { kind: "selected", projectIds: [PROJECT_B] },
    });
    expect(approved.kind).toBe("approved");
  });

  it("marks a client ID metadata document client as verified", async () => {
    const clientId = "https://agent.example/oauth/client.json";
    await store.save(
      CONSENT_ID,
      pendingConsent({
        authRequest: authRequest({ clientId }),
        client: { clientId, clientName: null },
      }),
    );

    const result = await consentService(store).get(CONSENT_ID, OWNER);

    expect(result.kind === "found" && result.details.client).toEqual({
      name: clientId,
      metadataUrl: clientId,
      verified: true,
      redirectHost: "127.0.0.1:9999",
    });
  });

  // SECURITY REGRESSION GUARDRAIL (SEC-013): an agent that asks for nothing gets read only.
  it("offers only the read scopes when the client asks for no Doxa scope", async () => {
    await store.save(
      CONSENT_ID,
      pendingConsent({ authRequest: authRequest({ scope: ["offline_access"] }) }),
    );

    const result = await consentService(store).get(CONSENT_ID, OWNER);

    expect(result.kind === "found" && result.details.requestedScopes).toEqual(
      OAUTH_SCOPES.filter((scope) => scope.endsWith(":read")),
    );
  });

  it.each([
    ["an unknown ID", "d".repeat(43)],
    ["a malformed ID", "../grant:owner"],
  ])("returns not_found for %s", async (_label, id) => {
    await store.save(CONSENT_ID, pendingConsent());

    expect(await consentService(store).get(id, OWNER)).toEqual({ kind: "not_found" });
  });

  it("returns not_found once the consent is past its deadline", async () => {
    await store.save(CONSENT_ID, pendingConsent());
    const later = () => new Date(NOW.getTime() + 600_000);

    expect(await consentService(store, oauth, later).get(CONSENT_ID, OWNER)).toEqual({
      kind: "not_found",
    });
  });
});

describe("ConsentService.approve", () => {
  it("completes the authorization for the session user with typed props", async () => {
    await store.save(CONSENT_ID, pendingConsent());

    const result = await consentService(store, oauth).approve(CONSENT_ID, OWNER, {
      scopes: ["docs:write", "docs:write"],
      projectScope: { kind: "selected", projectIds: [PROJECT_A] },
    });

    expect(result).toEqual({
      kind: "approved",
      redirectTo: "http://127.0.0.1:9999/callback?code=abc&state=state-1",
    });
    expect(oauth.completeAuthorization).toHaveBeenCalledOnce();
    const options = oauth.completeAuthorization.mock.calls[0][0];
    expect(options.request).toEqual(authRequest());
    expect(options.userId).toBe(OWNER);
    expect(options.scope).toEqual(["docs:write"]);
    expect(agentGrantPropsSchema.parse(options.props)).toEqual({
      version: 1,
      grantRef: GRANT_REF,
      userId: OWNER,
      clientName: "Claude Code",
      projectScope: { kind: "selected", projectIds: [PROJECT_A] },
    });
    expect(agentGrantMetadataSchema.parse(options.metadata)).toEqual({
      clientName: "Claude Code",
      cimd: false,
      grantRef: GRANT_REF,
      projectScope: { kind: "selected", projectIds: [PROJECT_A] },
    });
  });

  it("adds offline_access only when the client asked for it", async () => {
    await store.save(
      CONSENT_ID,
      pendingConsent({ authRequest: authRequest({ scope: ["docs:read", "offline_access"] }) }),
    );

    await consentService(store, oauth).approve(CONSENT_ID, OWNER, approveAll);

    expect(oauth.completeAuthorization.mock.calls[0][0].scope).toEqual([
      "docs:read",
      "offline_access",
    ]);
  });

  it("is single use", async () => {
    await store.save(CONSENT_ID, pendingConsent());
    const service = consentService(store, oauth);

    await service.approve(CONSENT_ID, OWNER, approveAll);
    const second = await service.approve(CONSENT_ID, OWNER, approveAll);

    expect(second).toEqual({ kind: "not_found" });
    expect(oauth.completeAuthorization).toHaveBeenCalledOnce();
  });

  it("removes the consent before it makes the grant", async () => {
    await store.save(CONSENT_ID, pendingConsent());
    const seen: boolean[] = [];
    oauth.completeAuthorization.mockImplementation(async () => {
      seen.push(store.consents.has(CONSENT_ID));
      return { redirectTo: "http://127.0.0.1:9999/callback?code=abc" };
    });

    await consentService(store, oauth).approve(CONSENT_ID, OWNER, approveAll);

    expect(seen).toEqual([false]);
  });

  it("rejects scopes the client did not request and keeps the consent", async () => {
    await store.save(CONSENT_ID, pendingConsent());

    const result = await consentService(store, oauth).approve(CONSENT_ID, OWNER, {
      scopes: ["docs:read", "publish"],
      projectScope: { kind: "all" },
    });

    expect(result).toMatchObject({
      kind: "rejected",
      issues: [{ path: "/scopes/1", severity: "error" }],
    });
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
    expect(store.consents.has(CONSENT_ID)).toBe(true);
  });

  it("accepts only read scopes when the client requested none", async () => {
    await store.save(CONSENT_ID, pendingConsent({ authRequest: authRequest({ scope: [] }) }));

    const write = await consentService(store, oauth).approve(CONSENT_ID, OWNER, {
      scopes: ["publish", "generation:run"],
      projectScope: { kind: "all" },
    });
    expect(write.kind).toBe("rejected");

    const read = await consentService(store, oauth).approve(CONSENT_ID, OWNER, {
      scopes: ["projects:read", "docs:read"],
      projectScope: { kind: "all" },
    });
    expect(read.kind).toBe("approved");
  });

  it("rejects a selected project the user does not own", async () => {
    await store.save(CONSENT_ID, pendingConsent());

    const result = await consentService(store, oauth).approve(CONSENT_ID, OWNER, {
      scopes: ["docs:read"],
      projectScope: { kind: "selected", projectIds: [PROJECT_A, OTHER_PROJECT] },
    });

    expect(result).toMatchObject({
      kind: "rejected",
      issues: [{ path: "/projectScope/projectIds/1" }],
    });
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
  });

  it("binds the grant to whoever approves, checking that user's projects", async () => {
    await store.save(CONSENT_ID, pendingConsent());

    const result = await consentService(store, oauth).approve(CONSENT_ID, OTHER, {
      scopes: ["docs:read"],
      projectScope: { kind: "selected", projectIds: [OTHER_PROJECT] },
    });

    expect(result.kind).toBe("approved");
    expect(oauth.completeAuthorization.mock.calls[0][0].userId).toBe(OTHER);
  });
});

describe("ConsentService.deny", () => {
  it("removes the consent and returns the access_denied redirect", async () => {
    await store.save(CONSENT_ID, pendingConsent());

    const result = await consentService(store, oauth).deny(CONSENT_ID);

    expect(result.kind).toBe("denied");
    const location = new URL(result.kind === "denied" ? result.redirectTo : "");
    expect(location.origin + location.pathname).toBe("http://127.0.0.1:9999/callback");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-1");
    expect(location.searchParams.get("iss")).toBe(ISSUER);
    expect(store.consents.size).toBe(0);
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
  });

  it("returns not_found for a used consent", async () => {
    expect(await consentService(store, oauth).deny(CONSENT_ID)).toEqual({ kind: "not_found" });
  });
});
