import { describe, expect, it } from "vitest";
import {
  agentActor,
  dashboardActor,
  editOriginFor,
  toProjectId,
  type AgentActorClaims,
} from "../../../src/services/agent-access/actor";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";

function claims(overrides: Partial<AgentActorClaims> = {}): AgentActorClaims {
  return {
    userId: "user-1",
    clientId: "client-1",
    clientName: "Claude Code",
    grantRef: "22222222-2222-4222-8222-222222222222",
    scopes: ["docs:read"],
    projectScope: { kind: "all" },
    ...overrides,
  };
}

describe("dashboardActor", () => {
  it("builds a user principal on the dashboard channel", () => {
    expect(dashboardActor("user-1")).toEqual({
      principal: { kind: "user", userId: "user-1" },
      channel: { kind: "dashboard" },
    });
  });
});

describe("agentActor", () => {
  it("expands granted scopes", () => {
    const actor = agentActor(claims({ scopes: ["publish"] }));
    expect([...actor.channel.scopes].sort()).toEqual(["docs:read", "publish"]);
  });

  it.each([
    [["docs:read", "admin"], ["docs:read"]],
    [["openid", "offline_access"], []],
    [["DOCS:READ"], []],
  ])("ignores unknown scopes in %j", (scopes, expected) => {
    const actor = agentActor(claims({ scopes }));
    expect([...actor.channel.scopes]).toEqual(expected);
  });

  it("keeps client and grant identity", () => {
    const { channel, principal } = agentActor(claims());
    expect(principal.userId).toBe("user-1");
    expect(channel).toMatchObject({
      kind: "agent",
      clientId: "client-1",
      clientName: "Claude Code",
      grantRef: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("maps an all-projects claim", () => {
    expect(agentActor(claims()).channel.projectScope).toEqual({ kind: "all" });
  });

  it("maps a selected-projects claim to a set", () => {
    const { projectScope } = agentActor(
      claims({ projectScope: { kind: "selected", projectIds: [PROJECT_A] } }),
    ).channel;
    expect(projectScope.kind).toBe("selected");
    if (projectScope.kind !== "selected") return;
    expect(projectScope.projectIds.has(toProjectId(PROJECT_A))).toBe(true);
    expect(projectScope.projectIds.size).toBe(1);
  });
});

describe("editOriginFor", () => {
  it.each([
    ["dashboard", dashboardActor("user-1"), "editor"],
    ["agent", agentActor(claims()), "mcp"],
  ] as const)("returns the origin for the %s channel", (_, actor, origin) => {
    expect(editOriginFor(actor)).toBe(origin);
  });
});
