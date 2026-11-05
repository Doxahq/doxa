import { describe, expect, it, vi } from "vitest";

import type { RuntimeSearchDocument } from "../src/contracts";
import {
  createTypesenseReader,
  createTypesenseWriter,
  SearchIndexMissingError,
  SearchProviderError,
} from "../src/providers";

const INDEX = "s_site_version";
const document: RuntimeSearchDocument = {
  id: "/a",
  slug: "/a",
  title: "Alpha",
  description: "",
  breadcrumb: [],
  section: "default",
  headings: ["One"],
  keywords: [],
  content: "alpha text",
  lines: [{ text: "alpha text", anchor: "one" }],
};

function connection(fetcher: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return fetcher(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return {
    calls,
    connection: { host: "https://cluster.example", apiKey: "secret", fetch: fetchMock },
  };
}

/** The answer of a healthy cluster: one line for each document in the body. */
function acknowledge(body: string): string {
  return body
    .split("\n")
    .map(() => '{"success":true}')
    .join("\n");
}

describe("Typesense reader", () => {
  it("sends search text in the body with fixed settings", async () => {
    const { calls, connection: conn } = connection(() =>
      Response.json({
        results: [
          {
            hits: [
              {
                document: {
                  id: "/a",
                  slug: "/a",
                  title: "Alpha",
                  lines: [{ text: "alpha text", anchor: "one" }],
                },
                highlights: [{ matched_tokens: ["alpha"] }],
                text_match: 7,
              },
            ],
          },
        ],
      }),
    );
    const results = await createTypesenseReader(conn).search({
      indexKey: INDEX,
      query: "alpha&filter_by=site:other",
      limit: 8,
    });

    expect(results[0]).toMatchObject({ slug: "/a", snippetAnchor: "one", score: 7 });
    const call = calls[0]!;
    expect(call.url).toBe("https://cluster.example/multi_search");
    const body = JSON.parse(String(call.init.body)).searches[0];
    expect(body.collection).toBe(INDEX);
    expect(body.q).toBe("alpha&filter_by=site:other");
    expect(body).not.toHaveProperty("filter_by");
  });

  it("reports a missing collection as a missing index", async () => {
    const { connection: conn } = connection(() =>
      Response.json({ results: [{ code: 404, error: "Not found." }] }),
    );
    await expect(
      createTypesenseReader(conn).search({ indexKey: INDEX, query: "ab", limit: 8 }),
    ).rejects.toBeInstanceOf(SearchIndexMissingError);
  });

  it("does not put provider text in an error", async () => {
    const { connection: conn } = connection(
      () => new Response("secret detail", { status: 500 }),
    );
    const error = await createTypesenseReader(conn)
      .search({ indexKey: INDEX, query: "ab", limit: 8 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SearchProviderError);
    expect((error as Error).message).not.toContain("secret");
  });

  it("refuses a host that is not a plain HTTPS origin", () => {
    for (const host of [
      "http://cluster.example",
      "https://user:pass@cluster.example",
      "https://cluster.example/path",
    ]) {
      expect(() =>
        createTypesenseReader({ host, apiKey: "secret" }),
      ).toThrow(SearchProviderError);
    }
  });
});

describe("Typesense writer", () => {
  it("creates the collection, accepts an existing one, and imports in batches", async () => {
    const documents = Array.from({ length: 251 }, (_, index) => ({
      ...document,
      id: `/d${index}`,
    }));
    const { calls, connection: conn } = connection((url, init) =>
      url.endsWith("/collections")
        ? new Response("exists", { status: 409 })
        : new Response(acknowledge(String(init.body))),
    );
    const facts = await createTypesenseWriter(conn).writeIndex({
      indexKey: INDEX,
      documents,
    });

    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toContain(`/collections/${INDEX}/documents/import?action=upsert`);
    expect(facts.documents).toBe(251);
    expect(facts.indexedBytes).toBeGreaterThan(0);
  });

  it("fails when a document is rejected", async () => {
    const { connection: conn } = connection((url) =>
      url.endsWith("/collections")
        ? new Response("{}", { status: 201 })
        : new Response('{"success":false,"error":"bad"}'),
    );
    await expect(
      createTypesenseWriter(conn).writeIndex({ indexKey: INDEX, documents: [document] }),
    ).rejects.toBeInstanceOf(SearchProviderError);
  });

  // PRODUCT REGRESSION GUARDRAIL: an incomplete index must never become ready.
  it.each([
    ["an empty answer", ""],
    ["a short answer", '{"success":true}'],
    ["a line that is not JSON", '{"success":true}\nnot json'],
    ["a line without success", '{"success":true}\n{"code":200}'],
    ["an extra failed line", '{"success":true}\n{"success":true}\n{"success":false}'],
  ])("fails on %s", async (_name, answer) => {
    const { connection: conn } = connection((url) =>
      url.endsWith("/collections")
        ? new Response("{}", { status: 201 })
        : new Response(answer),
    );
    await expect(
      createTypesenseWriter(conn).writeIndex({
        indexKey: INDEX,
        documents: [document, { ...document, id: "/other" }],
      }),
    ).rejects.toBeInstanceOf(SearchProviderError);
  });

  it("accepts a trailing newline", async () => {
    const { connection: conn } = connection((url) =>
      url.endsWith("/collections")
        ? new Response("{}", { status: 201 })
        : new Response('{"success":true}\n'),
    );
    await expect(
      createTypesenseWriter(conn).writeIndex({ indexKey: INDEX, documents: [document] }),
    ).resolves.toMatchObject({ documents: 1 });
  });

  it("tells a missing index from a provider failure", async () => {
    const missing = connection(() => new Response("gone", { status: 404 }));
    await expect(createTypesenseWriter(missing.connection).hasIndex(INDEX)).resolves.toBe(false);

    const present = connection(() => Response.json({ name: INDEX }));
    await expect(createTypesenseWriter(present.connection).hasIndex(INDEX)).resolves.toBe(true);

    const outage = connection(() => new Response("down", { status: 503 }));
    await expect(createTypesenseWriter(outage.connection).hasIndex(INDEX)).rejects.toBeInstanceOf(
      SearchProviderError,
    );
  });

  // PRODUCT REGRESSION GUARDRAIL: a stalled provider must not hold the scheduler.
  it("gives every request a deadline, and keeps the caller's", async () => {
    const { calls, connection: conn } = connection(() => new Response('{"success":true}'));
    await createTypesenseWriter(conn).removeIndex(INDEX);
    const withoutCaller = calls[0]!.init.signal;
    expect(withoutCaller).toBeInstanceOf(AbortSignal);

    const controller = new AbortController();
    await createTypesenseWriter(conn).removeIndex(INDEX, controller.signal);
    const withCaller = calls[1]!.init.signal!;
    expect(withCaller.aborted).toBe(false);
    controller.abort();
    expect(withCaller.aborted).toBe(true);
  });

  it("counts a missing index as removed", async () => {
    const { connection: conn } = connection(
      () => new Response("gone", { status: 404 }),
    );
    await expect(createTypesenseWriter(conn).removeIndex(INDEX)).resolves.toBeUndefined();
  });
});
