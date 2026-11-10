import { schema, type DbEnv } from "@doxahq/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readTables: unknown[] = [];

vi.mock("@doxahq/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@doxahq/db")>()),
  createDb: () => ({
    select: () => ({
      from: (table: unknown) => {
        readTables.push(table);
        return { where: () => ({ groupBy: async () => [] }) };
      },
    }),
  }),
}));

const { AgentActivityRepository } = await import("../../src/repositories/agent-activity");

const env = {} as DbEnv;

beforeEach(() => {
  readTables.length = 0;
});

describe("AgentActivityRepository.lastActivityByGrantRef", () => {
  it("reads only the audit table while the live activity is off", async () => {
    await new AgentActivityRepository(env).lastActivityByGrantRef("user-1", ["grant-1"]);
    expect(readTables).toEqual([schema.agentActivity]);
  });

  it("also reads the live events while the live activity is on", async () => {
    await new AgentActivityRepository(env, { includeLiveEvents: true }).lastActivityByGrantRef("user-1", ["grant-1"]);
    expect(readTables).toEqual([schema.agentActivity, schema.agentLiveEvents]);
  });
});
