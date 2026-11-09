import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { MAX_CLAIMS_PER_CLIENT_IP_PER_HOUR, MAX_CLAIMS_PER_LOGIN_HINT_AND_IP_PER_HOUR, MAX_CLAIMS_PER_LOGIN_HINT_PER_HOUR, MAX_USER_CODE_ATTEMPTS, MAX_ACTIVE_AGENT_TOKENS_PER_USER } =
  await import("../../../src/services/agent-signup/agent-signup-config");
const { MCP_RESOURCE, OTHER, OTHER_PROJECT, OWNER, OWNER_EMAIL, PROJECT_A, WEB_ORIGIN, harness, registered } = await import("./fakes");

const ALL_PROJECTS = { kind: "all" } as const;
const WRONG_CODE = "000000";

type Context = ReturnType<typeof harness>;

function approval(attemptToken: string, userCode: string, overrides = {}) {
  return { attemptToken, userCode, scopes: ["docs:read" as const], projectScope: ALL_PROJECTS, ...overrides };
}

function differentCode(code: string): string {
  return code === WRONG_CODE ? "000001" : WRONG_CODE;
}

async function approved(context: Context, request = {}) {
  const claim = await registered(context, request);
  expect(await context.consent.approve(approval(claim.attemptToken, claim.grant.userCode), OWNER)).toEqual({ kind: "approved" });
  return claim;
}

describe("registration", () => {
  it("returns the link and the code, and stores only hashes", async () => {
    const context = harness();
    const { grant, attemptToken } = await registered(context, { login_hint: OWNER_EMAIL });

    expect(grant.verificationUri).toBe(`${WEB_ORIGIN}/oauth/claim?attempt=${attemptToken}`);
    expect(grant.userCode).toMatch(/^\d{6}$/);
    expect(grant.expiresIn).toBe(300);
    expect(grant.interval).toBe(5);
    const stored = JSON.stringify([...context.claims.claims.values()]);
    expect(stored).not.toContain(grant.claimToken);
    expect(stored).not.toContain(attemptToken);
    expect(stored).not.toContain(`"${grant.userCode}"`);
  });

  it("drops unknown scopes and offers read scopes when the agent asks for none", async () => {
    const asked = await registered(harness(), { scope: "docs:write admin:everything" });
    expect(asked.grant.scopes).toEqual(["docs:write"]);
    const none = await registered(harness(), { scope: undefined });
    expect(none.grant.scopes).toEqual(["projects:read", "docs:read"]);
  });

  it("limits claims for one email from one IP, and for one IP", async () => {
    const byEmail = harness();
    for (let i = 0; i < MAX_CLAIMS_PER_LOGIN_HINT_AND_IP_PER_HOUR; i += 1) await registered(byEmail, { login_hint: OWNER_EMAIL });
    await expect(registered(byEmail, { login_hint: OWNER_EMAIL })).rejects.toThrow();
    byEmail.clock.advance(3601);
    await expect(registered(byEmail, { login_hint: OWNER_EMAIL })).resolves.toBeDefined();

    const byIp = harness();
    for (let i = 0; i < MAX_CLAIMS_PER_CLIENT_IP_PER_HOUR; i += 1) await registered(byIp);
    await expect(registered(byIp)).rejects.toThrow();
  });

  it("does not let a stranger use up the budget of a victim's email", async () => {
    const context = harness();
    for (let i = 0; i < MAX_CLAIMS_PER_LOGIN_HINT_AND_IP_PER_HOUR; i += 1) {
      await registered(context, { login_hint: OWNER_EMAIL }, "198.51.100.7");
    }
    await expect(registered(context, { login_hint: OWNER_EMAIL }, "203.0.113.9")).resolves.toBeDefined();
  });

  it("caps one email across all IPs", async () => {
    const context = harness();
    for (let i = 0; i < MAX_CLAIMS_PER_LOGIN_HINT_PER_HOUR; i += 1) {
      await registered(context, { login_hint: OWNER_EMAIL }, `198.51.100.${i}`);
    }
    await expect(registered(context, { login_hint: OWNER_EMAIL }, "203.0.113.9")).rejects.toThrow();
  });
});

describe("polling", () => {
  it("names the pending step, and asks a fast agent to slow down", async () => {
    const context = harness();
    const { grant, attemptToken } = await registered(context);

    expect(await context.agent.poll(grant.claimToken)).toEqual({ kind: "pending", stage: "link_not_opened" });
    expect(await context.agent.poll(grant.claimToken)).toEqual({ kind: "slow_down" });
    context.clock.advance(5);
    await context.consent.open(attemptToken);
    expect(await context.agent.poll(grant.claimToken)).toEqual({ kind: "pending", stage: "user_action_required" });
  });

  it("rejects an unknown or malformed claim token", async () => {
    const context = harness();
    expect(await context.agent.poll("not-a-token")).toEqual({ kind: "invalid" });
    expect(await context.agent.poll(`doxa_clm_${"a".repeat(43)}`)).toEqual({ kind: "invalid" });
  });

  it("reports expiry after 5 minutes when nobody opened the link", async () => {
    const context = harness();
    const { grant, attemptToken } = await registered(context);
    context.clock.advance(300);
    expect(await context.agent.poll(grant.claimToken)).toEqual({ kind: "expired" });
    expect(await context.consent.open(attemptToken)).toBe(false);
  });

  it("issues exactly one token, with the approved access only", async () => {
    const context = harness();
    const { grant } = await approved(context);

    const issued = await context.agent.poll(grant.claimToken);
    expect(issued).toMatchObject({ kind: "issued", scope: "docs:read", mcpUrl: MCP_RESOURCE });
    if (issued.kind !== "issued") throw new Error("Expected a token.");
    expect(issued.accessToken).toMatch(/^doxa_at_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify([...context.tokens.tokens.values()])).not.toContain(issued.accessToken);

    context.clock.advance(5);
    expect(await context.agent.poll(grant.claimToken)).toEqual({ kind: "invalid" });
    expect(context.tokens.tokens.size).toBe(1);
  });

  it("tells the person once, and keeps the token when the email fails", async () => {
    const context = harness();
    const { grant } = await approved(context);
    context.notifyConnected.mockRejectedValueOnce(new Error("queue down"));
    const issued = await context.agent.poll(grant.claimToken);
    expect(issued.kind).toBe("issued");
    expect(context.notifyConnected).toHaveBeenCalledTimes(1);
    expect(context.notifyConnected).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER, agentName: "Claude Code", scopes: ["docs:read"] }),
    );
  });

  it("does not issue a token past the account limit, even for an approved claim", async () => {
    const context = harness();
    const { grant } = await approved(context);
    for (let i = 0; i < MAX_ACTIVE_AGENT_TOKENS_PER_USER; i += 1) {
      context.tokens.insert(
        { userId: OWNER, tokenHash: `h-${i}`, tokenName: "x", clientName: "x", scopes: [], projectScope: ALL_PROJECTS, grantRef: crypto.randomUUID(), expiresAt: new Date("2030-01-01T00:00:00.000Z") },
        context.clock.now(),
      );
    }
    expect(await context.agent.poll(grant.claimToken)).toEqual({ kind: "invalid" });
  });

  it("gives parallel polls of an approved claim one token at most", async () => {
    const context = harness();
    const { grant } = await approved(context);
    const results = await Promise.all([context.agent.poll(grant.claimToken), context.agent.poll(grant.claimToken)]);
    expect(results.filter((result) => result.kind === "issued")).toHaveLength(1);
    expect(context.tokens.tokens.size).toBe(1);
  });

  it("expires an approved claim that the agent never collects", async () => {
    const context = harness();
    const { grant } = await approved(context);
    context.clock.advance(300);
    expect(await context.agent.poll(grant.claimToken)).toEqual({ kind: "expired" });
    expect(context.tokens.tokens.size).toBe(0);
  });
});

describe("the claim page", () => {
  it("keeps the 5-minute limit when the link opens", async () => {
    const context = harness();
    const { attemptToken, grant } = await registered(context);
    const claim = () => [...context.claims.claims.values()][0]!;
    const expiresAt = claim().expiresAt.getTime();
    context.clock.advance(60);
    expect(await context.consent.open(attemptToken)).toBe(true);
    expect(claim().openedAt).not.toBeNull();
    expect(claim().expiresAt.getTime()).toBe(expiresAt);

    context.clock.advance(240);
    expect(await context.consent.open(attemptToken)).toBe(false);
    expect(await context.agent.poll(grant.claimToken)).toEqual({ kind: "expired" });
  });

  it("does not reveal the code in the details", async () => {
    const context = harness();
    const { grant, attemptToken } = await registered(context);
    const result = await context.consent.details(attemptToken, OWNER);
    expect(result).toMatchObject({ kind: "found", details: { clientName: "Claude Code", accountMatches: true } });
    expect(JSON.stringify(result)).not.toContain(grant.userCode);
  });

  it("counts wrong codes and locks the claim at the limit", async () => {
    const context = harness();
    const { grant, attemptToken } = await registered(context);
    const wrong = differentCode(grant.userCode);

    for (let left = MAX_USER_CODE_ATTEMPTS - 1; left > 0; left -= 1) {
      expect(await context.consent.approve(approval(attemptToken, wrong), OWNER)).toEqual({ kind: "wrong_code", attemptsLeft: left });
    }
    expect(await context.consent.approve(approval(attemptToken, wrong), OWNER)).toEqual({ kind: "not_found" });
    expect(await context.consent.approve(approval(attemptToken, grant.userCode), OWNER)).toEqual({ kind: "not_found" });
    expect(await context.agent.poll(grant.claimToken)).toEqual({ kind: "denied" });
  });

  it("spends an attempt before the comparison, so parallel guesses cannot pass the limit", async () => {
    const context = harness();
    const { grant, attemptToken } = await registered(context);
    const reserve = vi.spyOn(context.claims, "reserveCodeAttempt");
    const guesses = Array.from({ length: 50 }, () =>
      context.consent.approve(approval(attemptToken, differentCode(grant.userCode)), OWNER),
    );
    const results = await Promise.all(guesses);
    expect(reserve).toHaveBeenCalled();
    expect(results.filter((result) => result.kind === "wrong_code").length).toBeLessThan(MAX_USER_CODE_ATTEMPTS);
    expect([...context.claims.claims.values()][0]!.codeAttempts).toBe(MAX_USER_CODE_ATTEMPTS);
  });

  it("does not spend an attempt on a wrong form choice", async () => {
    const context = harness();
    const { grant, attemptToken } = await registered(context);
    const notRequested = await context.consent.approve(approval(attemptToken, grant.userCode, { scopes: ["publish"] }), OWNER);
    expect(notRequested.kind).toBe("rejected");
    const foreignProject = await context.consent.approve(
      approval(attemptToken, grant.userCode, { projectScope: { kind: "selected", projectIds: [OTHER_PROJECT] } }),
      OWNER,
    );
    expect(foreignProject.kind).toBe("rejected");
    expect([...context.claims.claims.values()][0]!.codeAttempts).toBe(0);
  });

  it("accepts a project that the person can read", async () => {
    const context = harness();
    const { grant, attemptToken } = await registered(context);
    const result = await context.consent.approve(
      approval(attemptToken, grant.userCode, { projectScope: { kind: "selected", projectIds: [PROJECT_A] } }),
      OWNER,
    );
    expect(result).toEqual({ kind: "approved" });
  });

  it("refuses an account that does not match the email from the agent", async () => {
    const context = harness({ emails: { [OWNER]: OWNER_EMAIL, [OTHER]: "someone@doxa.test" } });
    const { grant, attemptToken } = await registered(context, { login_hint: OWNER_EMAIL });

    expect(await context.consent.details(attemptToken, OTHER)).toMatchObject({ details: { accountMatches: false } });
    expect(await context.consent.approve(approval(attemptToken, grant.userCode), OTHER)).toEqual({ kind: "account_mismatch" });
    expect([...context.claims.claims.values()][0]!.codeAttempts).toBe(0);
  });

  it("compares the email without case", async () => {
    const context = harness({ emails: { [OWNER]: "Owner@Doxa.Test" } });
    const { grant, attemptToken } = await registered(context, { login_hint: OWNER_EMAIL });
    expect(await context.consent.approve(approval(attemptToken, grant.userCode), OWNER)).toEqual({ kind: "approved" });
  });

  it("refuses a new token when the account is at its limit", async () => {
    const context = harness();
    for (let i = 0; i < MAX_ACTIVE_AGENT_TOKENS_PER_USER; i += 1) {
      context.tokens.insert(
        {
          userId: OWNER,
          tokenHash: `hash-${i}`,
          tokenName: "x",
          clientName: "x",
          scopes: [],
          projectScope: ALL_PROJECTS,
          grantRef: crypto.randomUUID(),
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        },
        context.clock.now(),
      );
    }
    const { grant, attemptToken } = await registered(context);
    expect(await context.consent.approve(approval(attemptToken, grant.userCode), OWNER)).toEqual({ kind: "token_limit" });
  });

  it("ends the claim when the person denies it", async () => {
    const context = harness();
    const { grant, attemptToken } = await registered(context);
    expect(await context.consent.deny(attemptToken, OWNER)).toBe(true);
    expect(await context.agent.poll(grant.claimToken)).toEqual({ kind: "denied" });
    expect(await context.consent.approve(approval(attemptToken, grant.userCode), OWNER)).toEqual({ kind: "not_found" });
  });

  it("does not let another account deny a claim that names an email", async () => {
    const context = harness({ emails: { [OWNER]: OWNER_EMAIL, [OTHER]: "someone@doxa.test" } });
    const { attemptToken } = await registered(context, { login_hint: OWNER_EMAIL });
    expect(await context.consent.deny(attemptToken, OTHER)).toBe(false);
    expect([...context.claims.claims.values()][0]!.status).toBe("pending");
  });

  it("cannot approve a claim twice", async () => {
    const context = harness();
    const { grant, attemptToken } = await approved(context);
    expect(await context.consent.approve(approval(attemptToken, grant.userCode), OTHER)).toEqual({ kind: "not_found" });
    expect([...context.claims.claims.values()][0]!.approvedUserId).toBe(OWNER);
  });
});
