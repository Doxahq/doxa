import { schema } from "@doxahq/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, test } from "vitest";

import { DocsHostnameSourceRepository } from "../../src/repositories/docs-hostname-source";

// Real Drizzle SQL with a stubbed pg transport.
function database(responses: unknown[][][] = []) {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const client = {
    query: async (query: string | { text: string }, params: unknown[] = []) => {
      const text = typeof query === "string" ? query : query.text;
      queries.push({ text, params });
      return { rows: responses.shift() ?? [] };
    },
  };
  const db = drizzle(client as never, { schema });
  return {
    repository: new DocsHostnameSourceRepository(
      { DOCS_BASE_DOMAIN: "doxa.page" },
      db,
    ),
    queries,
  };
}

describe("docs hostname source SQL", () => {
  test("lists published sites and their routable domains as public candidates", async () => {
    const state = database([[["demo"], ["Not A Slug"]], [["docs.acme.com"]]]);
    expect(await state.repository.listPublicHostnames()).toEqual([
      "demo.doxa.page",
      "docs.acme.com",
    ]);
    const [sites, domains] = state.queries.map(({ text }) => text);
    expect(sites).toContain('"published_version_id" is not null');
    expect(domains).toContain('"docs_domains"."status" = $1');
    expect(domains).toContain('"docs_domains"."verification_status" = $2');
    expect(domains).toContain('"published_version_id" is not null');
    expect(state.queries[1]?.params).toEqual(["active", "verified"]);
  });

  test("lists every hostname of a site, whatever the domain state", async () => {
    const state = database([[["demo"]], [["docs.acme.com"], ["old.acme.com"]]]);
    expect(await state.repository.listSiteHostnames("site-1")).toEqual([
      "demo.doxa.page",
      "docs.acme.com",
      "old.acme.com",
    ]);
    const [, domains] = state.queries;
    expect(domains?.text).not.toContain("status");
    expect(domains?.params).toEqual(["site-1"]);
  });

  test("lists only the domains of a deleted site", async () => {
    const state = database([[], []]);
    expect(await state.repository.listSiteHostnames("gone")).toEqual([]);
  });
});
