import { schema } from "@doxahq/db";
import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * SECURITY REGRESSION GUARDRAIL (SEC-025): a signed body replayed with a new
 * X-GitHub-Delivery ID is a duplicate, unless the first delivery failed.
 */
const mock = vi.hoisted(() => ({
  createDb: vi.fn(),
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  answers: [] as unknown[][][],
}));

vi.mock("@doxahq/db", async (original) => ({
  ...(await original<typeof import("@doxahq/db")>()),
  createDb: mock.createDb,
}));

import { WebhookDeliveriesRepository } from "../../src/repositories/webhook-deliveries";

const input = {
  provider: "github" as const,
  deliveryId: "delivery-new",
  eventName: "pull_request",
  action: "opened",
  repositoryExternalId: "42",
  payloadHash: "hash-1",
  normalizedEvent: { kind: "ignored", reason: "test" } as never,
};

describe("WebhookDeliveriesRepository.claimDelivery replay check", () => {
  beforeEach(() => {
    mock.queries.length = 0;
    mock.answers = [];
    mock.createDb.mockReturnValue(
      drizzle(
        async (sql, params) => {
          mock.queries.push({ sql, params });
          return { rows: mock.answers.shift() ?? [] };
        },
        { schema },
      ),
    );
  });

  test("treats the same body for the same repository and event as a duplicate", async () => {
    mock.answers = [[["existing-id"]]];

    await expect(new WebhookDeliveriesRepository({} as never).claimDelivery(input)).resolves.toBe("duplicate");

    expect(mock.queries).toHaveLength(1);
    const [lookup] = mock.queries;
    expect(lookup?.sql).toMatch(/"payload_hash" = \$\d+/);
    expect(lookup?.sql).toMatch(/"status" not in \(\$\d+, \$\d+\)/);
    expect(lookup?.params).toEqual(expect.arrayContaining(["42", "github", "pull_request", "hash-1", "failed", "enqueue_failed"]));
  });

  test("claims a body that no earlier delivery brought", async () => {
    mock.answers = [[], [["new-id"]]];

    await expect(new WebhookDeliveriesRepository({} as never).claimDelivery(input)).resolves.toBe("claimed");
    expect(mock.queries[1]?.sql).toMatch(/^insert into "scm_webhook_deliveries"/);
  });

  test("skips the lookup for an event without a repository", async () => {
    mock.answers = [[["new-id"]]];

    await expect(
      new WebhookDeliveriesRepository({} as never).claimDelivery({ ...input, repositoryExternalId: null }),
    ).resolves.toBe("claimed");
    expect(mock.queries).toHaveLength(1);
  });
});
