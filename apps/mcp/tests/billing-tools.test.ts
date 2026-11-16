import { describe, expect, it, vi } from "vitest";
import {
  AiAdmissionError,
  CreditsExhaustedError,
  PlanLimitError,
  type McpBilling,
  type McpBillingAccount,
} from "@doxahq/api/services/billing/mcp-billing";
import { mapToolError } from "../src/errors";
import { PlatformActionError } from "../src/services/platform-actions";
import { OWNER, PROJECT_A } from "./support/fixtures";
import { createHarness } from "./support/harness";
import { callTool, toolError } from "./support/tool-calls";

function fakeBilling(overrides: Partial<Pick<McpBilling, "consumeToolCall" | "accountsFor">> = {}) {
  return {
    mode: "on" as const,
    consumeToolCall: vi.fn(overrides.consumeToolCall ?? (async () => undefined)),
    accountsFor: vi.fn(overrides.accountsFor ?? (async () => [])),
  };
}

async function call(name: string, args: Record<string, unknown>, billing: ReturnType<typeof fakeBilling>) {
  const harness = createHarness({ services: (fakes) => ({ ...fakes, billing }) });
  const client = await harness.connect("modern");
  return callTool(client, name, args);
}

describe("the daily tool-call quota (billing spec 11)", () => {
  it("counts a project tool once, after the access policy allowed the project", async () => {
    const billing = fakeBilling();
    const outcome = await call("get_project", { projectId: PROJECT_A }, billing);
    expect(outcome.isError).toBeFalsy();
    expect(billing.consumeToolCall).toHaveBeenCalledTimes(1);
    expect(billing.consumeToolCall).toHaveBeenCalledWith(PROJECT_A);
  });

  it("never counts a call on a project that the actor cannot use", async () => {
    const billing = fakeBilling();
    const outcome = await call("get_project", { projectId: "99999999-0000-4000-8000-000000000000" }, billing);
    expect(outcome.isError).toBe(true);
    expect(billing.consumeToolCall).not.toHaveBeenCalled();
  });

  it("does not count the tools without a project", async () => {
    const billing = fakeBilling();
    await call("list_projects", {}, billing);
    await call("get_account", {}, billing);
    expect(billing.consumeToolCall).not.toHaveBeenCalled();
  });

  it("a call above the limit is a plan_limit tool error with the reset time", async () => {
    const resetsAt = new Date("2026-11-14T00:00:00.000Z");
    const billing = fakeBilling({
      consumeToolCall: async () => {
        throw new PlanLimitError({ key: "mcp.tool_calls_per_day", limit: 100, used: 101, resetsAt });
      },
    });
    const error = toolError(await call("get_project", { projectId: PROJECT_A }, billing));
    expect(error).toMatchObject({
      code: "plan_limit",
      details: { key: "mcp.tool_calls_per_day", limit: 100, used: 101, resetsAt: resetsAt.toISOString() },
    });
    expect(error.hint).toContain(resetsAt.toISOString());
  });
});

describe("get_account billing (billing spec 15.3)", () => {
  it("adds the plan, credits, pay-as-you-go and today's tool calls of each account", async () => {
    const account: McpBillingAccount = {
      accountId: "acct_1",
      ownerKind: "user",
      teamId: null,
      plan: "pro",
      credits: { available: 4_200, resetsAt: "2026-12-13T12:00:00.000Z" },
      payg: { active: true, debt: 120, monthlyLimitCents: 3_000 },
      toolCalls: { today: 7, limit: "unlimited", resetsAt: "2026-11-14T00:00:00.000Z" },
    };
    const billing = fakeBilling({ accountsFor: async () => [account] });
    const outcome = await call("get_account", {}, billing);
    expect(outcome.structured["billing"]).toEqual([account]);
    expect(billing.accountsFor).toHaveBeenCalledWith(OWNER, expect.any(Array));
  });

  it("has no billing field while billing enforcement is off", async () => {
    const billing = fakeBilling({ accountsFor: async () => null });
    const outcome = await call("get_account", {}, billing);
    expect(outcome.structured).not.toHaveProperty("billing");
  });
});

describe("billing errors as tool errors", () => {
  it("maps 402 credits_exhausted with its facts", () => {
    const error = new CreditsExhaustedError({ accountId: "acct_1", available: 10, needed: 450, reason: "payg_off", resetsAt: null });
    expect(mapToolError(error, "req-1")).toMatchObject({
      code: "credits_exhausted",
      details: { available: 10, needed: 450, reason: "payg_off" },
    });
  });

  it("maps the refusals that the actions RPC carries", () => {
    expect(mapToolError(new PlatformActionError("credits_exhausted", "Not enough AI credits: 0 available."), "req-1")).toMatchObject({
      code: "credits_exhausted",
      message: "Not enough AI credits: 0 available.",
    });
    expect(mapToolError(new PlatformActionError("plan_limit", "No Doxa Agent."), "req-1").code).toBe("plan_limit");
    expect(mapToolError(new PlatformActionError("model_unpriced", "x"), "req-1").code).toBe("ai_unavailable");
    expect(mapToolError(new AiAdmissionError("ai_paused_for_review", "paused", {}), "req-1").code).toBe("ai_paused_for_review");
  });
});
