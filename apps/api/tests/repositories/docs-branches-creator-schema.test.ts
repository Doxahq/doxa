import { schema } from "@doxahq/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  creatorColumns,
  toStoredBranch,
} from "../../src/repositories/docs-branch-records";

describe("docs_branches creator columns (v2 spec §11)", () => {
  const config = getTableConfig(schema.docsBranches);

  it("adds nullable creator columns, so dashboard branches keep them empty", () => {
    const columns = new Map(config.columns.map((column) => [column.name, column]));
    expect(columns.get("created_by_client_id")?.notNull).toBe(false);
    expect(columns.get("created_by_client_name")?.notNull).toBe(false);
    expect(columns.get("created_by_user_id")?.notNull).toBe(false);
  });

  it("requires the client ID and the client name together", () => {
    expect(config.checks.map((check) => check.name)).toContain(
      "docs_branches_creator_client_complete",
    );
  });

  it("allows the creator user only on an agent branch", () => {
    expect(config.checks.map((check) => check.name)).toContain(
      "docs_branches_creator_user_has_client",
    );
  });

  it("clears the creator user, not the branch, when the member is deleted", () => {
    const [foreignKey] = config.foreignKeys.filter((key) =>
      key.reference().columns.some((column) => column.name === "created_by_user_id"),
    );
    expect(foreignKey?.onDelete).toBe("set null");
  });
});

describe("branch creator mapping", () => {
  const row: typeof schema.docsBranches.$inferSelect = {
    id: "11111111-1111-4111-8111-111111111111",
    siteId: "22222222-2222-4222-8222-222222222222",
    kind: "named",
    purpose: "user",
    name: "agent-docs",
    ownerUserId: "owner",
    baseVersionId: "33333333-3333-4333-8333-333333333333",
    createdFromBranchId: null,
    revision: 0,
    previewRevision: null,
    createdByClientId: null,
    createdByClientName: null,
    createdByUserId: null,
    createdAt: new Date("2026-10-05T00:00:00.000Z"),
    updatedAt: new Date("2026-10-05T00:00:00.000Z"),
  };

  it("reads a branch without a client as a user branch", () => {
    expect(toStoredBranch(row).createdBy).toEqual({ kind: "user" });
  });

  it("round-trips an agent creator", () => {
    const creator = {
      kind: "agent",
      clientId: "client-1",
      clientName: "Test Agent",
      userId: "member",
    } as const;
    expect(toStoredBranch({ ...row, ...creatorColumns(creator) }).createdBy).toEqual(
      creator,
    );
    expect(creatorColumns({ kind: "user" })).toEqual({
      createdByClientId: null,
      createdByClientName: null,
      createdByUserId: null,
    });
  });
});
