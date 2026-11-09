import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { AgentTokenAuthenticator } = await import(
  "../../../src/services/agent-signup/agent-token-authenticator"
);
const { newAgentToken, sha256Hex } = await import("../../../src/services/agent-signup/agent-signup-secrets");
const { Clock, MCP_RESOURCE, MemoryAgentTokenStore, OWNER } = await import("./fakes");

const GRANT_REF = "44444444-4444-4444-8444-444444444444";
const DAY_SECONDS = 24 * 3600;
const THIRTY_DAYS_SECONDS = 30 * DAY_SECONDS;

async function setup(overrides: { projectScope?: unknown; expiresAt?: Date } = {}) {
  const clock = new Clock();
  const tokens = new MemoryAgentTokenStore();
  const token = newAgentToken();
  tokens.insert(
    {
      userId: OWNER,
      tokenHash: await sha256Hex(token),
      tokenName: "Acme docs",
      clientName: "Claude Code",
      scopes: ["docs:read"],
      projectScope: overrides.projectScope ?? { kind: "all" },
      grantRef: GRANT_REF,
      expiresAt: overrides.expiresAt ?? new Date("2027-01-01T00:00:00.000Z"),
    },
    clock.now(),
  );
  const authenticator = new AgentTokenAuthenticator({ tokens, mcpResource: MCP_RESOURCE, now: clock.now });
  return { authenticator, clock, token, tokens };
}

describe("AgentTokenAuthenticator", () => {
  it("returns the same shape as an OAuth access token", async () => {
    const { authenticator, token } = await setup();
    expect(await authenticator.validate(MCP_RESOURCE, token)).toEqual({
      props: { version: 1, grantRef: GRANT_REF, userId: OWNER, clientName: "Claude Code", projectScope: { kind: "all" } },
      audience: MCP_RESOURCE,
      expiresAt: Math.floor(new Date("2027-01-01T00:00:00.000Z").getTime() / 1000),
      scope: ["docs:read"],
      userId: OWNER,
      clientId: `doxa-agent-token:${GRANT_REF}`,
    });
  });

  it("rejects another resource, an unknown token, and a bad stored scope", async () => {
    const { authenticator, token } = await setup();
    expect(await authenticator.validate("https://other.test/mcp", token)).toBeNull();
    expect(await authenticator.validate(MCP_RESOURCE, newAgentToken())).toBeNull();
    const bad = await setup({ projectScope: { kind: "everything" } });
    expect(await bad.authenticator.validate(MCP_RESOURCE, bad.token)).toBeNull();
  });

  it("rejects a revoked or expired token at once", async () => {
    const { authenticator, clock, token, tokens } = await setup();
    await tokens.revokeByHash(await sha256Hex(token), clock.now());
    expect(await authenticator.validate(MCP_RESOURCE, token)).toBeNull();

    const expired = await setup({ expiresAt: new Date("2026-11-09T12:00:01.000Z") });
    expired.clock.advance(1);
    expect(await expired.authenticator.validate(MCP_RESOURCE, expired.token)).toBeNull();
  });

  it("rejects a token after 30 days without use", async () => {
    const recent = await setup();
    recent.clock.advance(THIRTY_DAYS_SECONDS - 1);
    expect(await recent.authenticator.validate(MCP_RESOURCE, recent.token)).not.toBeNull();

    const idle = await setup();
    idle.clock.advance(THIRTY_DAYS_SECONDS);
    expect(await idle.authenticator.validate(MCP_RESOURCE, idle.token)).toBeNull();
  });

  it("gives another 30 days after each use, but never passes the end date", async () => {
    const { authenticator, clock, token } = await setup({
      expiresAt: new Date(new Clock().now().getTime() + 40 * DAY_SECONDS * 1000),
    });
    clock.advance(29 * DAY_SECONDS);
    expect(await authenticator.validate(MCP_RESOURCE, token)).not.toBeNull();
    clock.advance(6 * DAY_SECONDS);
    expect(await authenticator.validate(MCP_RESOURCE, token)).not.toBeNull();
    clock.advance(6 * DAY_SECONDS);
    expect(await authenticator.validate(MCP_RESOURCE, token)).toBeNull();
  });

  it("records use at most once per hour, and survives a failed write", async () => {
    const { authenticator, clock, token, tokens } = await setup();
    await authenticator.validate(MCP_RESOURCE, token);
    await authenticator.validate(MCP_RESOURCE, token);
    expect(tokens.touches).toBe(1);
    clock.advance(3601);
    await authenticator.validate(MCP_RESOURCE, token);
    expect(tokens.touches).toBe(2);

    clock.advance(3601);
    tokens.touch = async () => {
      throw new Error("database down");
    };
    expect(await authenticator.validate(MCP_RESOURCE, token)).not.toBeNull();
  });
});
