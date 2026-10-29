import { describe, expect, it } from "vitest";
import { CLIENT_REGION_HEADER } from "@doxahq/api-bridge";
import { readClientWarmPool } from "../../src/http/client-region";

function withCf(request: Request, cf: Record<string, unknown>): Request {
  Object.defineProperty(request, "cf", { value: cf });
  return request;
}

describe("readClientWarmPool", () => {
  it("reads the edge's header on the Node origin, where there is no request.cf", () => {
    const request = new Request("https://api.doxa.so/me", { headers: { [CLIENT_REGION_HEADER]: "asia-ne" } });

    expect(readClientWarmPool(request)).toBe("asia-ne");
  });

  it("ignores a header that names no known pool", () => {
    const request = new Request("https://api.doxa.so/me", { headers: { [CLIENT_REGION_HEADER]: "mars" } });

    expect(readClientWarmPool(request)).toBeNull();
    expect(readClientWarmPool(new Request("https://api.doxa.so/me"))).toBeNull();
  });

  it("reads only request.cf as a Worker, never a client-sent header", () => {
    const located = withCf(
      new Request("https://api.doxa.so/me", { headers: { [CLIENT_REGION_HEADER]: "oceania" } }),
      { colo: "SIN" },
    );
    const unknown = withCf(
      new Request("https://api.doxa.so/me", { headers: { [CLIENT_REGION_HEADER]: "oceania" } }),
      { country: "IN", continent: "AS" },
    );

    expect(readClientWarmPool(located)).toBe("singapore");
    expect(readClientWarmPool(unknown)).toBeNull();
  });
});
