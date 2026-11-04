import { describe, expect, test, vi } from "vitest";

const serverFetch = vi.fn(async () => new Response("rendered"));

vi.mock("virtual:tanstack-start-server-entry", () => ({
  default: { fetch: serverFetch },
  DocsPrerenderRenderer: class {},
}));

describe("renderer worker entry", () => {
  test("passes the execution context, which carries the request scope", async () => {
    const { default: worker } = await import("../worker.js");
    const request = new Request("https://docs.example.com/guide");
    const env = {};
    const ctx = { props: { content: {}, resolution: {} } };

    await worker.fetch(request, env, ctx);

    expect(serverFetch).toHaveBeenCalledWith(request, env, ctx);
  });
});
