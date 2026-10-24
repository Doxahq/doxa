import { describe, expect, test } from "vitest";
import { instanceName, RUN_ID_HEADER, utilityGate, type UtilityGateEnv } from "../src/utility/gate";
import { UTILITY_JOBS } from "../src/utility/registry";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

interface RecordedCall {
  instance: string;
  request?: Request;
  destroyed?: boolean;
}

function gateEnv(responseBody: BodyInit = JSON.stringify({ ok: true, output: {} })) {
  const calls: RecordedCall[] = [];
  const env: UtilityGateEnv = {
    UTILITY_SPEC_READER: {
      getByName: (instance) => ({
        fetch: async (request) => {
          calls.push({ instance, request });
          return new Response(responseBody, { headers: { "content-type": "application/json" } });
        },
        destroy: async () => {
          calls.push({ instance, destroyed: true });
        },
      }),
    },
  };
  return { env, calls };
}

function jobRequest(path: string, init: RequestInit & { runId?: string } = {}): Request {
  const body = init.body ?? "{}";
  return new Request(`http://utility.internal${path}`, {
    method: "POST",
    body,
    ...init,
    headers: {
      "content-type": "application/json",
      "content-length": String(typeof body === "string" ? body.length : 0),
      [RUN_ID_HEADER]: init.runId ?? RUN_ID,
      ...init.headers,
    },
  });
}

describe("utility gate", () => {
  test("runs a registered job in the instance of its run", async () => {
    const { env, calls } = gateEnv();

    const response = await utilityGate(jobRequest("/v1/jobs/spec-reader/run"), env);

    expect(response.status).toBe(200);
    expect(calls.map((call) => call.instance)).toEqual([`spec-reader:${RUN_ID}`]);
    expect(new URL(calls[0]!.request!.url).pathname).toBe("/run");
  });

  test("passes only the content headers, never a key or a token", async () => {
    const { env, calls } = gateEnv();

    await utilityGate(jobRequest("/v1/jobs/spec-reader/run", {
      headers: { authorization: "Bearer ghp_secret", cookie: "session=1", "x-api-key": "sk_live_1" },
    }), env);

    expect([...calls[0]!.request!.headers.keys()].sort()).toEqual(["content-length", "content-type"]);
  });

  test.each([
    ["an unknown job", "/v1/jobs/agent/run"],
    ["a job name with path characters", "/v1/jobs/spec-reader%2F..%2Fagent/run"],
    ["an unknown action", "/v1/jobs/spec-reader/exec"],
    ["an inherited property name", "/v1/jobs/constructor/run"],
  ])("refuses %s before any instance starts", async (_label, path) => {
    const { env, calls } = gateEnv();

    expect((await utilityGate(jobRequest(path), env)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test("accepts only POST", async () => {
    const { env } = gateEnv();

    const response = await utilityGate(new Request("http://utility.internal/v1/jobs/spec-reader/run", {
      headers: { [RUN_ID_HEADER]: RUN_ID },
    }), env);

    expect(response.status).toBe(405);
  });

  test.each(["", "run-1", "../agent", `${RUN_ID}:x`])("refuses the run ID %j", async (runId) => {
    const { env, calls } = gateEnv();

    expect((await utilityGate(jobRequest("/v1/jobs/spec-reader/run", { runId }), env)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("refuses a request with no length or more than the job limit", async () => {
    const { env, calls } = gateEnv();
    const limit = UTILITY_JOBS["spec-reader"].maxRequestBytes;

    const tooLarge = await utilityGate(jobRequest("/v1/jobs/spec-reader/run", {
      headers: { "content-length": String(limit + 1) },
    }), env);
    const noLength = await utilityGate(new Request("http://utility.internal/v1/jobs/spec-reader/run", {
      method: "POST",
      headers: { [RUN_ID_HEADER]: RUN_ID },
    }), env);

    expect([tooLarge.status, noLength.status]).toEqual([413, 411]);
    expect(calls).toEqual([]);
  });

  test("destroys the instance of the run when the run is done", async () => {
    const { env, calls } = gateEnv();

    const response = await utilityGate(jobRequest("/v1/jobs/spec-reader/done"), env);

    expect(response.status).toBe(204);
    expect(calls).toEqual([{ instance: `spec-reader:${RUN_ID}`, destroyed: true }]);
  });

  test("fails a response body that passes the job output limit", async () => {
    const limit = UTILITY_JOBS["spec-reader"].maxResponseBytes;
    const { env } = gateEnv(new Uint8Array(limit + 1));

    const response = await utilityGate(jobRequest("/v1/jobs/spec-reader/run"), env);

    await expect(response.arrayBuffer()).rejects.toThrow(/larger than/);
  });

  test("names one instance for each job and run", () => {
    expect(instanceName("spec-reader", RUN_ID.toUpperCase())).toBe(`spec-reader:${RUN_ID}`);
  });
});
