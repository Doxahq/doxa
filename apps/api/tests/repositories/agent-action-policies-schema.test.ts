import { schema } from "@doxahq/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

describe("agent_action_policies schema", () => {
  const config = getTableConfig(schema.agentActionPolicies);

  it("has the columns of v2 spec §11", () => {
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "scope_kind",
      "project_id",
      "user_id",
      "action_kind",
      "mode",
      "updated_by_user_id",
      "updated_at",
    ]);
  });

  it("keeps one row for each scope and action", () => {
    const unique = config.indexes
      .filter((index) => index.config.unique)
      .map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) => ("name" in column ? column.name : null)),
      }));
    expect(unique).toEqual([
      { name: "agent_action_policies_project_action_idx", columns: ["project_id", "action_kind"] },
      { name: "agent_action_policies_user_action_idx", columns: ["user_id", "action_kind"] },
    ]);
  });

  it("goes away with its project or user", () => {
    const references = config.foreignKeys.map((key) => {
      const reference = key.reference();
      return { columns: reference.columns.map((column) => column.name), onDelete: key.onDelete };
    });
    expect(references).toEqual(
      expect.arrayContaining([
        { columns: ["project_id"], onDelete: "cascade" },
        { columns: ["user_id"], onDelete: "cascade" },
        { columns: ["updated_by_user_id"], onDelete: "set null" },
      ]),
    );
  });

  it("stores only the three approval modes", () => {
    expect(schema.agentApprovalMode.enumValues).toEqual(["allow", "require_approval", "deny"]);
  });

  it("defaults the project erase setting to true", () => {
    const column = getTableConfig(schema.projects).columns.find((entry) => entry.name === "erase_branch_after_publish");
    expect(column).toMatchObject({ notNull: true, default: true });
  });
});
