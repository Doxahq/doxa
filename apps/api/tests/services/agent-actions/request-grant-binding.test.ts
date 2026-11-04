import { describe, expect, it } from "vitest";
import { agentActor } from "../../../src/services/agent-access/actor";
import { isRequestingAgent } from "../../../src/services/agent-actions/request-access";
import type { ApprovalRequestRecord } from "../../../src/repositories/agent-approval-requests";

/** SECURITY REGRESSION GUARDRAIL (SEC-030): requests belong to the grant that made them. */
describe("isRequestingAgent", () => {
  const record = {
    requestedByUserId: "owner-1",
    requestedByClientId: "client-1",
    grantRef: "grant-a",
  } as ApprovalRequestRecord;

  function agent(grantRef: string, clientId = "client-1", userId = "owner-1") {
    return agentActor({
      userId,
      clientId,
      clientName: "Agent",
      grantRef,
      scopes: [],
      projectScope: { kind: "all" },
    });
  }

  it("matches the same user, client and grant", () => {
    expect(isRequestingAgent(agent("grant-a"), record)).toBe(true);
  });

  it("does not match another grant of the same client", () => {
    expect(isRequestingAgent(agent("grant-b"), record)).toBe(false);
  });

  it("does not match another client or user", () => {
    expect(isRequestingAgent(agent("grant-a", "client-2"), record)).toBe(false);
    expect(isRequestingAgent(agent("grant-a", "client-1", "someone-else"), record)).toBe(false);
  });
});
