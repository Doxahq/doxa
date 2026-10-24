import { schema } from "@doxahq/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

function foreignKeys(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table).foreignKeys.map((key) => ({
    columns: key.reference().columns.map((column) => column.name),
    onDelete: key.onDelete,
  }));
}

describe("teams schema (v2 spec §11)", () => {
  it("has no owner column: ownership is a member with the owner role", () => {
    const columns = getTableConfig(schema.teams).columns.map((column) => column.name);
    expect(columns).toEqual(["id", "name", "created_at", "updated_at"]);
    expect(schema.teamRole.enumValues).toEqual(["owner", "admin", "editor", "viewer"]);
  });

  it("keeps one membership for each team and user", () => {
    const config = getTableConfig(schema.teamMembers);
    expect(config.primaryKeys.map((key) => key.columns.map((column) => column.name))).toEqual([["team_id", "user_id"]]);
    expect(foreignKeys(schema.teamMembers)).toEqual(
      expect.arrayContaining([
        { columns: ["team_id"], onDelete: "cascade" },
        { columns: ["user_id"], onDelete: "cascade" },
      ]),
    );
  });

  it("stores a unique token hash, never a token", () => {
    const config = getTableConfig(schema.teamInvites);
    const columns = config.columns.map((column) => column.name);
    expect(columns).toContain("token_hash");
    expect(columns).not.toContain("token");
    expect(columns).toEqual(
      expect.arrayContaining(["role", "expires_at", "created_by_user_id", "used_at", "used_by_user_id", "revoked_at"]),
    );
    const unique = config.indexes.filter((index) => index.config.unique).map((index) => index.config.name);
    expect(unique).toEqual(["team_invites_token_hash_idx"]);
  });

  it("adds a nullable team to projects that blocks deleting a team with projects", () => {
    const column = getTableConfig(schema.projects).columns.find((entry) => entry.name === "team_id");
    expect(column?.notNull).toBe(false);
    expect(foreignKeys(schema.projects)).toEqual(
      expect.arrayContaining([{ columns: ["team_id"], onDelete: "restrict" }]),
    );
  });

  it("defaults require_other_decider to false", () => {
    const column = getTableConfig(schema.projects).columns.find((entry) => entry.name === "require_other_decider");
    expect(column).toMatchObject({ notNull: true, default: false });
  });
});
