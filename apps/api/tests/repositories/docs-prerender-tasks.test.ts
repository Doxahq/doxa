import { describe, expect, test } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  createObsoletePrerenderTaskCondition,
  readDocsPrerenderTaskConfig,
  retryDelaySeconds,
} from "../../src/repositories/docs-prerender-tasks";

describe("docs pre-render task policy", () => {
  test("fails closed without an exact release identity", () => {
    expect(
      readDocsPrerenderTaskConfig({
        DOCS_BASE_DOMAIN: "doxa.page",
        DOXA_RENDERER_RELEASE_ID: "unconfigured",
      }),
    ).toBeNull();
  });

  test("normalizes the trusted generated-domain configuration", () => {
    expect(
      readDocsPrerenderTaskConfig({
        DOCS_BASE_DOMAIN: " DOXA.PAGE ",
        DOXA_RENDERER_RELEASE_ID: "a".repeat(64),
      }),
    ).toEqual({
      docsBaseDomain: "doxa.page",
      rendererReleaseId: "a".repeat(64),
      accessPolicy: "public",
    });
  });

  test("uses bounded exponential retry delay with jitter", () => {
    expect(retryDelaySeconds(1, () => 0)).toBe(30);
    expect(retryDelaySeconds(2, () => 0.5)).toBe(66);
    expect(retryDelaySeconds(8, () => 0.999)).toBe(900);
  });

  test("obsoletes unfinished work from a previous renderer release", () => {
    const currentRelease = "b".repeat(64);
    const query = new PgDialect().sqlToQuery(
      createObsoletePrerenderTaskCondition({
        docsBaseDomain: "doxa.page",
        rendererReleaseId: currentRelease,
        accessPolicy: "public",
      }).getSQL(),
    );

    expect(query.sql).toContain('"renderer_release_id" <> $');
    expect(query.params).toContain(currentRelease);
    expect(query.params).toEqual(
      expect.arrayContaining(["pending", "running", "failed"]),
    );
  });
});
