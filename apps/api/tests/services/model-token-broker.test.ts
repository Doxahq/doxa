import { modelAccessTokenSchema } from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  ANTHROPIC_TOKEN_URL,
  FederatedModelTokenBroker,
  MIN_TOKEN_LIFETIME_MS,
  ModelTokenExchangeError,
} from "../../src/services/model-access/model-token-broker";
import { federationConfigFromVars } from "../../src/runtime/node/model-access/model-token-broker-from-vars";

const CONFIG = {
  federationRuleId: "fdrl_test",
  organizationId: "00000000-0000-4000-8000-000000000000",
  serviceAccountId: "svac_test",
  workspaceId: "wrkspc_test",
};

function setup(responses: Array<() => Response>, start = 1_000_000) {
  let now = start;
  let jwtCount = 0;
  const fetchRequest = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("No response left.");
    return next();
  });
  const broker = new FederatedModelTokenBroker({
    config: CONFIG,
    identityToken: async () => `jwt-${++jwtCount}`,
    fetch: fetchRequest,
    now: () => now,
  });
  return { broker, fetchRequest, advance: (ms: number) => { now += ms; } };
}

const tokenResponse = (token: string, expiresIn = 3600) => () =>
  Response.json({ access_token: token, expires_in: expiresIn, token_type: "Bearer" });

describe("FederatedModelTokenBroker", () => {
  test("exchanges a fresh identity JWT with the rule's IDs", async () => {
    const { broker, fetchRequest } = setup([tokenResponse("sk-ant-oat01-a")]);

    const token = await broker.getToken();

    expect(modelAccessTokenSchema.parse(token)).toEqual(token);
    expect(token.token).toBe("sk-ant-oat01-a");
    const [url, init] = fetchRequest.mock.calls[0]!;
    expect(url).toBe(ANTHROPIC_TOKEN_URL);
    expect(JSON.parse(String(init?.body))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "jwt-1",
      federation_rule_id: "fdrl_test",
      organization_id: CONFIG.organizationId,
      service_account_id: "svac_test",
      workspace_id: "wrkspc_test",
    });
  });

  test("reuses a token while it outlasts a stage, then exchanges a new JWT", async () => {
    const { broker, fetchRequest, advance } = setup([tokenResponse("first"), tokenResponse("second")]);

    expect((await broker.getToken()).token).toBe("first");
    advance(5 * 60_000);
    expect((await broker.getToken()).token).toBe("first");
    advance(3600_000 - MIN_TOKEN_LIFETIME_MS);
    expect((await broker.getToken()).token).toBe("second");

    const assertions = fetchRequest.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).assertion);
    expect(assertions).toEqual(["jwt-1", "jwt-2"]);
  });

  test("concurrent stages share one exchange", async () => {
    const { broker, fetchRequest } = setup([tokenResponse("shared")]);

    const tokens = await Promise.all([broker.getToken(), broker.getToken(), broker.getToken()]);

    expect(tokens.map((token) => token.token)).toEqual(["shared", "shared", "shared"]);
    expect(fetchRequest).toHaveBeenCalledOnce();
  });

  test("a token shorter than a stage is refused with the fix", async () => {
    const { broker } = setup([tokenResponse("short", 600)]);

    await expect(broker.getToken()).rejects.toThrow(/Set the federation rule's token lifetime to 3600 seconds/);
  });

  test("a refused exchange names the status and reason, and the next call tries again", async () => {
    const { broker } = setup([
      () => Response.json({ error: { type: "authentication_error", message: "Authentication failed" } }, { status: 401 }),
      tokenResponse("after-fix"),
    ]);

    const error = await broker.getToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelTokenExchangeError);
    expect(error).toMatchObject({ status: 401 });
    expect(String(error)).toContain("authentication_error: Authentication failed");
    expect(String(error)).not.toContain("jwt-1");
    expect((await broker.getToken()).token).toBe("after-fix");
  });
});

describe("federationConfigFromVars", () => {
  const vars = {
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
    ANTHROPIC_ORGANIZATION_ID: CONFIG.organizationId,
    ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test",
    ANTHROPIC_WORKSPACE_ID: "wrkspc_test",
  };

  test("no federation variables means no broker: local development keeps its key", () => {
    expect(federationConfigFromVars({})).toBeNull();
  });

  test("all four variables give the config", () => {
    expect(federationConfigFromVars(vars)).toEqual(CONFIG);
  });

  test("some variables without the others stop the origin", () => {
    const { ANTHROPIC_WORKSPACE_ID: _missing, ...partial } = vars;

    expect(() => federationConfigFromVars(partial)).toThrow(/ANTHROPIC_WORKSPACE_ID/);
  });
});
