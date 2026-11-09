import { schema } from "@doxahq/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { outcomeFor, recordsActivity, sha256Hex } from "../src/activity";
import { rateLimitKey } from "../src/rate-limit";
import { agentActor } from "@doxahq/api/services/agent-access/actor";

describe("agent_activity schema", () => {
  const config = getTableConfig(schema.agentActivity);

  it("has the columns of spec 11.2", () => {
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "occurred_at",
      "user_id",
      "client_id",
      "client_name",
      "grant_ref",
      "project_id",
      "tool",
      "action_kind",
      "approval_request_id",
      "outcome",
      "error_code",
      "policy_source",
      "duration_ms",
      "input_sha256",
      // v2 §4: the old and the new value of an approval setting change.
      "details",
    ]);
  });

  it("cascades from users and projects, and unlinks deleted approval requests", () => {
    const references = config.foreignKeys.map((key) => {
      const reference = key.reference();
      return {
        columns: reference.columns.map((column) => column.name),
        table: getTableConfig(reference.foreignTable).name,
        onDelete: key.onDelete,
      };
    });
    expect(references).toEqual(
      expect.arrayContaining([
        { columns: ["user_id"], table: "user", onDelete: "cascade" },
        { columns: ["project_id"], table: "projects", onDelete: "cascade" },
        {
          columns: ["approval_request_id"],
          table: "agent_approval_requests",
          onDelete: "set null",
        },
      ]),
    );
    expect(references).toHaveLength(3);
  });

  it("indexes by project and by user, newest last", () => {
    const indexes = config.indexes.map((index) => ({
      name: index.config.name,
      columns: index.config.columns.map((column) =>
        "name" in column ? column.name : null,
      ),
    }));
    expect(indexes).toEqual([
      {
        name: "agent_activity_project_occurred_idx",
        columns: ["project_id", "occurred_at"],
      },
      {
        name: "agent_activity_user_occurred_idx",
        columns: ["user_id", "occurred_at"],
      },
    ]);
  });

  it("has the outcomes of spec 11.2", () => {
    expect(schema.agentActivityOutcome.enumValues).toEqual([
      "succeeded",
      "failed",
      "approval_required",
      "denied",
      "rate_limited",
    ]);
  });
});

describe("activity helpers", () => {
  it("records only write and expensive calls", () => {
    expect([
      recordsActivity("read"),
      recordsActivity("write"),
      recordsActivity("expensive"),
    ]).toEqual([false, true, true]);
  });

  it.each([
    [null, "succeeded"],
    ["rate_limited", "rate_limited"],
    ["not_found", "denied"],
    ["project_not_in_grant", "denied"],
    ["insufficient_scope", "denied"],
    ["conflict", "failed"],
    ["internal_error", "failed"],
  ] as const)("maps %s to %s", (code, outcome) => {
    expect(outcomeFor(code)).toBe(outcome);
  });

  it("hashes the input, never storing it", async () => {
    const hash = await sha256Hex({ content: "secret page" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await sha256Hex({ content: "secret page" }));
  });
});

describe("rateLimitKey", () => {
  it("gives the agent tokens of one user one budget", () => {
    const tokenActor = (grantRef: string) =>
      agentActor({
        userId: "user-1",
        clientId: `doxa-agent-token:${grantRef}`,
        clientName: "Agent",
        grantRef,
        scopes: [],
        projectScope: { kind: "all" },
      });
    expect(rateLimitKey("read", tokenActor("a"))).toBe(rateLimitKey("read", tokenActor("b")));
  });

  const actor = agentActor({
    userId: "user-1",
    clientId: "client-1",
    clientName: "Agent",
    grantRef: "88888888-8888-4888-8888-888888888888",
    scopes: [],
    projectScope: { kind: "all" },
  });

  it("keys reads and writes on the user and client, expensive calls on the user", () => {
    expect(rateLimitKey("read", actor)).toBe("user-1:client-1");
    expect(rateLimitKey("write", actor)).toBe("user-1:client-1");
    expect(rateLimitKey("expensive", actor)).toBe("user-1");
  });
});
