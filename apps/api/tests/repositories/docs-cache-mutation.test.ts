import { describe, expect, test, vi } from "vitest";
import { schema } from "@doxahq/db";

const delivery = vi.hoisted(() => ({ process: vi.fn() }));
vi.mock("../../src/services/docs-cache-invalidation", () => ({
  DocsCacheInvalidationWorker: class {
    process = delivery.process;
  },
}));

import { withDocsCacheInvalidation } from "../../src/repositories/docs-cache-mutation";

function fixture() {
  const events: string[] = [];
  const pending: unknown[] = [];
  const persisted: unknown[] = [];
  const tx = {
    insert: (table: unknown) => ({
      values: async (value: unknown) => {
        expect(table).toBe(schema.docsCacheInvalidations);
        pending.push(value);
        events.push("enqueue");
      },
    }),
  };
  const db = {
    transaction: async (mutate: (value: typeof tx) => Promise<unknown>) => {
      try {
        const result = await mutate(tx);
        persisted.push(...pending);
        events.push("commit");
        return result;
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    },
  };
  const binding = { invalidate: async () => {} };
  delivery.process.mockReset().mockImplementation(async () => {
    events.push("purge");
  });
  return { db, binding, events, persisted };
}

describe("docs cache mutation transaction", () => {
  test("commits the outbox before it attempts a purge", async () => {
    const state = fixture();
    const result = await withDocsCacheInvalidation(
      state.db as never,
      state.binding,
      async (_tx, enqueue) => {
        state.events.push("publish");
        await enqueue({ siteId: "site-1" });
        return "published-version";
      },
    );
    expect(result).toBe("published-version");
    expect(state.events).toEqual(["publish", "enqueue", "commit", "purge"]);
    expect(state.persisted).toEqual([
      { id: expect.any(String), siteId: "site-1" },
    ]);
  });

  test("does not purge or retain a task after transaction rollback", async () => {
    const state = fixture();
    await expect(
      withDocsCacheInvalidation(
        state.db as never,
        state.binding,
        async (_tx, enqueue) => {
          await enqueue({ siteId: "site-1" });
          throw new Error("publish failed");
        },
      ),
    ).rejects.toThrow("publish failed");
    expect(state.persisted).toEqual([]);
    expect(state.events).toEqual(["enqueue", "rollback"]);
  });

  test("preserves a successful publish when post-commit delivery fails", async () => {
    const state = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    delivery.process.mockRejectedValue(
      new Error("database temporarily unreachable"),
    );
    await expect(
      withDocsCacheInvalidation(
        state.db as never,
        state.binding,
        async (_tx, enqueue) => {
          await enqueue({ siteId: "site-1" });
          return "published-version";
        },
      ),
    ).resolves.toBe("published-version");
    expect(state.persisted).toHaveLength(1);
    warning.mockRestore();
  });

  test("retains the task locally without a configured binding", async () => {
    const state = fixture();
    await withDocsCacheInvalidation(
      state.db as never,
      undefined,
      async (_tx, enqueue) => {
        await enqueue({ siteId: "site-1" });
      },
    );
    expect(state.persisted).toHaveLength(1);
    expect(state.events).toEqual(["enqueue", "commit"]);
  });

  test("does not deliver tasks for a mutation that leaves production unchanged", async () => {
    const state = fixture();
    await withDocsCacheInvalidation(
      state.db as never,
      state.binding,
      async () => "preview",
    );
    expect(state.persisted).toEqual([]);
    expect(state.events).toEqual(["commit"]);
  });
});
