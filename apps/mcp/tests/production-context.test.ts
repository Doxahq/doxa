import type { Env } from "@doxahq/api/env";
import { describe, expect, test, vi } from "vitest";

const order: string[] = [];
const scopes = vi.hoisted(() => ({ envs: [] as Env[] }));

vi.mock("@doxahq/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@doxahq/db")>()),
  createRequestDbScope: (env: Env) => {
    scopes.envs.push(env);
    return { env, close: async () => void order.push("scope closed") };
  },
}));

const { openProductionContext } = await import("../src/production-context");
const { agentActor } = await import("@doxahq/api/services/agent-access/actor");
const { mcpBillingFromEnv } = await import("@doxahq/api/services/billing/mcp-billing");

const actor = agentActor({
  userId: "user-1",
  clientId: "client-1",
  clientName: "Test client",
  grantRef: "00000000-0000-4000-8000-000000000001",
  scopes: ["docs:read"],
  projectScope: { kind: "all" },
});

function mcpEnv(vars: Record<string, string> = {}) {
  return {
    MCP_RESOURCE_URL: "https://mcp.doxa.so/mcp",
    OAUTH_ISSUER: "https://api.doxa.so",
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
    DOCS_BUCKET: {},
    ...vars,
  } as never;
}

describe("production request context", () => {
  test("without a PostHog key, the API services get no analytics binding", async () => {
    scopes.envs.length = 0;
    const opened = openProductionContext(mcpEnv(), actor, () => {});
    await opened.close();

    expect(scopes.envs[0]).not.toHaveProperty("PRODUCT_ANALYTICS");
  });

  test("with a key, every service env carries analytics, and close flushes it before the pool ends", async () => {
    scopes.envs.length = 0;
    order.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        order.push("analytics sent");
        return new Response("{}", { status: 200 });
      }),
    );
    const opened = openProductionContext(mcpEnv({ POSTHOG_KEY: "phc_test" }), actor, () => {});
    const serviceEnv = scopes.envs[0];
    if (!serviceEnv?.PRODUCT_ANALYTICS) throw new Error("expected an analytics binding");
    // A group record needs no opt-out read, so this test needs no database.
    serviceEnv.PRODUCT_ANALYTICS.forEnv(serviceEnv).describeGroup({
      type: "project",
      key: "project-1",
      properties: { source: "repo" },
    });

    await opened.close();
    vi.unstubAllGlobals();

    expect(order).toEqual(["analytics sent", "scope closed"]);
  });

  // PRODUCTION INCIDENT REGRESSION GUARDRAIL (2026-11-25): the service env
  // dropped the billing vars, so every plan check in this Worker used the free
  // plan stubs, also for a Pro project.
  test("the API services get the Worker's billing settings", async () => {
    scopes.envs.length = 0;
    const billing = { BILLING_PROVIDER: "none", BILLING_ENFORCEMENT: "on", BILLING_DEFAULT_PLAN: "free" };
    const opened = openProductionContext(mcpEnv(billing), actor, () => {});
    await opened.close();

    const serviceEnv = scopes.envs[0];
    if (!serviceEnv) throw new Error("expected a service env");
    expect(serviceEnv).toMatchObject(billing);
    expect(mcpBillingFromEnv(serviceEnv).mode).toBe("on");
  });

  test("without billing settings, enforcement stays off, as on a self-hosted Worker", async () => {
    scopes.envs.length = 0;
    const opened = openProductionContext(mcpEnv(), actor, () => {});
    await opened.close();

    const serviceEnv = scopes.envs[0];
    if (!serviceEnv) throw new Error("expected a service env");
    expect(mcpBillingFromEnv(serviceEnv).mode).toBe("off");
  });
});
