import type { OAuthScope } from "@doxahq/contracts/agent-access";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpRequestContext } from "../src/request-context";
import {
  defineMcpTool,
  type AnyMcpTool,
  type ToolCost,
} from "../src/tool-definition";
import { runTool } from "../src/tool-runner";
import type { AgentActivityRecord } from "@doxahq/api/repositories/agent-activity";
import { createPlatformActions } from "../src/services/platform-actions";
import { createFakeActionsRpc } from "./support/fake-actions-rpc";
import { agentActor } from "@doxahq/api/services/agent-access/actor";
import { createFakeServices } from "./support/fake-services";
import { GRANT_REF, OWNER, PROJECT_A } from "./support/fixtures";

interface RunnerProbe {
  events: string[];
  activity: AgentActivityRecord[];
  pending: Promise<unknown>[];
  failures: string[];
}

function probeTool(
  options: { cost: ToolCost; scope?: OAuthScope | null; ok?: boolean },
  probe: RunnerProbe,
): AnyMcpTool {
  return defineMcpTool({
    name: "probe_tool",
    title: "Probe",
    description: "Test tool.",
    scope: options.scope === undefined ? "docs:write" : options.scope,
    cost: options.cost,
    annotations: {},
    input: z.object({ projectId: z.string() }).strict(),
    output: z
      .object({ ok: z.boolean() })
      .strict()
      .refine((value) => {
        probe.events.push("output");
        return value.ok;
      }),
    async run() {
      probe.events.push("run");
      return { ok: options.ok ?? true };
    },
  });
}

function probeContext(
  probe: RunnerProbe,
  options: { scopes?: string[]; allow?: boolean; failActivity?: boolean } = {},
): McpRequestContext {
  return {
    requestId: "request-1",
    actor: agentActor({
      userId: OWNER,
      clientId: "client-1",
      clientName: "Test Agent",
      grantRef: GRANT_REF,
      scopes: options.scopes ?? ["docs:write"],
      projectScope: { kind: "all" },
    }),
    policy: {
      authorize: async () => ({ allowed: false, reason: "not_found" }),
      listAccessibleProjects: async () => [],
    },
    services: createFakeServices(),
    actions: createPlatformActions(createFakeActionsRpc().rpc, agentActor({
      userId: OWNER,
      clientId: "client-1",
      clientName: "Test Agent",
      grantRef: GRANT_REF,
      scopes: [],
      projectScope: { kind: "all" },
    })),
    limiter: {
      allow: async (cost) => {
        probe.events.push(`limit:${cost}`);
        return options.allow ?? true;
      },
    },
    activity: {
      append: async (record) => {
        probe.events.push("audit");
        if (options.failActivity) throw new Error("database down");
        probe.activity.push(record);
      },
    },
    liveEvents: { append: async () => undefined },
    logger: {
      toolCall: (entry) => probe.events.push(`log:${entry.outcome}`),
      failure: (entry) => probe.failures.push(entry.event),
    },
    waitUntil: (promise) => probe.pending.push(promise),
    now: (() => {
      let clock = 0;
      return () => (clock += 10);
    })(),
  };
}

function newProbe(): RunnerProbe {
  return { events: [], activity: [], pending: [], failures: [] };
}

describe("runTool", () => {
  it("runs scope, limit, run, output check, log, then audit for a write tool", async () => {
    const probe = newProbe();
    const result = await runTool(
      probeTool({ cost: "write" }, probe),
      probeContext(probe),
      { projectId: PROJECT_A },
    );
    await Promise.all(probe.pending);
    expect(result).toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
      structuredContent: { ok: true },
    });
    expect(probe.events).toEqual([
      "limit:write",
      "run",
      "output",
      "log:succeeded",
      "audit",
    ]);
    expect(probe.activity).toEqual([
      expect.objectContaining({
        userId: OWNER,
        clientId: "client-1",
        clientName: "Test Agent",
        grantRef: GRANT_REF,
        projectId: PROJECT_A,
        tool: "probe_tool",
        outcome: "succeeded",
        errorCode: null,
        durationMs: 10,
        inputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it("writes no activity row for a read tool", async () => {
    const probe = newProbe();
    await runTool(probeTool({ cost: "read" }, probe), probeContext(probe), {
      projectId: PROJECT_A,
    });
    expect(probe.pending).toEqual([]);
    expect(probe.events).toEqual([
      "limit:read",
      "run",
      "output",
      "log:succeeded",
    ]);
  });

  it("stops before the limiter when the scope is missing, and audits the denial", async () => {
    const probe = newProbe();
    const result = await runTool(
      probeTool({ cost: "expensive" }, probe),
      probeContext(probe, { scopes: ["docs:read"] }),
      { projectId: PROJECT_A },
    );
    await Promise.all(probe.pending);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "insufficient_scope", requestId: "request-1" },
    });
    expect(probe.events).toEqual(["log:denied", "audit"]);
    expect(probe.activity[0]).toMatchObject({
      outcome: "denied",
      errorCode: "insufficient_scope",
    });
  });

  it("lets any valid token call a tool without scope", async () => {
    const probe = newProbe();
    const result = await runTool(
      probeTool({ cost: "read", scope: null }, probe),
      probeContext(probe, { scopes: [] }),
      { projectId: PROJECT_A },
    );
    expect(result.isError).toBeUndefined();
  });

  it("stops before the run when rate limited", async () => {
    const probe = newProbe();
    const result = await runTool(
      probeTool({ cost: "write" }, probe),
      probeContext(probe, { allow: false }),
      { projectId: PROJECT_A },
    );
    await Promise.all(probe.pending);
    expect(result.structuredContent).toMatchObject({
      error: { code: "rate_limited" },
    });
    expect(probe.events).toEqual(["limit:write", "log:rate_limited", "audit"]);
  });

  it("turns an output that fails its schema into internal_error and logs it", async () => {
    const probe = newProbe();
    const result = await runTool(
      probeTool({ cost: "read", ok: false }, probe),
      probeContext(probe),
      { projectId: PROJECT_A },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: "internal_error", requestId: "request-1" },
    });
    expect(probe.failures).toEqual(["mcp_tool_internal_error"]);
    expect(probe.events).toContain("log:failed");
  });

  it("logs a failed activity write instead of failing the call", async () => {
    const probe = newProbe();
    const result = await runTool(
      probeTool({ cost: "write" }, probe),
      probeContext(probe, { failActivity: true }),
      { projectId: PROJECT_A },
    );
    await Promise.all(probe.pending);
    expect(result.isError).toBeUndefined();
    expect(probe.failures).toEqual(["mcp_activity_write_failed"]);
  });
});
