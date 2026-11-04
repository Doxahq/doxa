import { describe, expect, it } from "vitest";
import { BRIDGE_KEY_HEADER, serveRemoteCall } from "@doxahq/api-bridge";
import { BridgeClient, createBridgedBindings } from "../../../src/runtime/node/bindings/bridge-bindings";

const KEY = "b".repeat(40);

/** An edge that answers each bridge call with `answer` and records the paths. */
function bridgeTo(answer: (args: unknown[]) => unknown) {
  const paths: string[] = [];
  const client = new BridgeClient({
    baseUrl: "https://api.doxa.so",
    key: KEY,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      paths.push(new URL(request.url).pathname);
      return serveRemoteCall(request, { keyHeader: BRIDGE_KEY_HEADER, key: KEY }, answer);
    },
  });
  return { bindings: createBridgedBindings(client), paths };
}

describe("bridged docs cache binding", () => {
  it("reads the warm status through the edge", async () => {
    const status = { siteId: "site-1", releaseId: null, startedAt: null, finishedAt: null, pools: [] };
    const { bindings, paths } = bridgeTo((args) => (args[0] as { siteId: string }).siteId === "site-1" ? status : null);

    await expect(bindings.DOCS_CACHE_INVALIDATOR.getWarmStatus?.({ siteId: "site-1" })).resolves.toEqual(status);
    expect(paths).toEqual(["/__bridge/call/DOCS_CACHE_INVALIDATOR/getWarmStatus"]);
  });

  it("throws the edge's error, for a dispatcher without the method", async () => {
    const { bindings } = bridgeTo(() => {
      throw new TypeError("DOCS_CACHE_INVALIDATOR.getWarmStatus is not a method.");
    });

    await expect(bindings.DOCS_CACHE_INVALIDATOR.getWarmStatus?.({ siteId: "site-1" })).rejects.toThrow(/not a method/);
  });
});
