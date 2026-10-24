import { describe, expect, test } from "vitest";
import {
  planWriteGroups,
  templatePageIdsOf,
  TEMPLATE_WRITE_GROUP_SIZE,
  writeGroupNoun,
  writingBudgetOf,
} from "../src/write-groups";

const endpointPageIds = Array.from(
  { length: TEMPLATE_WRITE_GROUP_SIZE + 2 },
  (_, index) => `api/endpoint-${index}`,
);
const guidePageIds = ["guides/start", "guides/auth", "guides/deploy"];

describe("write groups", () => {
  test("puts template pages first, in large groups, and keeps the page order of each kind", () => {
    const groups = planWriteGroups({
      pageIds: [guidePageIds[0]!, ...endpointPageIds, ...guidePageIds.slice(1)],
      templatePageIds: endpointPageIds,
      modelGroupSize: 2,
    });

    expect(groups.map((group) => [group.kind, group.pageIds.length])).toEqual([
      ["template", TEMPLATE_WRITE_GROUP_SIZE],
      ["template", 2],
      ["model", 2],
      ["model", 1],
    ]);
    expect(groups.filter((group) => group.kind === "template").flatMap((group) => group.pageIds))
      .toEqual(endpointPageIds);
    expect(groups.filter((group) => group.kind === "model").flatMap((group) => group.pageIds))
      .toEqual(guidePageIds);
  });

  test("ignores template page IDs that the run does not write", () => {
    const groups = planWriteGroups({
      pageIds: guidePageIds,
      templatePageIds: ["api/unchanged-endpoint"],
      modelGroupSize: 24,
    });

    expect(groups).toEqual([{ kind: "model", pageIds: guidePageIds }]);
  });

  test("sizes the time check from the groups of each kind", () => {
    const groups = planWriteGroups({
      pageIds: [...endpointPageIds, ...guidePageIds],
      templatePageIds: endpointPageIds,
      modelGroupSize: 24,
    });

    expect(writingBudgetOf(groups, {
      modelGroupSize: 24,
      timeouts: { model: 30 * 60_000, template: 10 * 60_000 },
      batchParallelism: 2,
    })).toEqual({
      pageCount: guidePageIds.length,
      pagesPerBatch: 24,
      pageBatchTimeoutMs: 30 * 60_000,
      batchParallelism: 2,
      templatePages: {
        pageCount: endpointPageIds.length,
        pagesPerBatch: TEMPLATE_WRITE_GROUP_SIZE,
        pageBatchTimeoutMs: 10 * 60_000,
      },
    });
  });

  test("names template steps apart from model steps", () => {
    expect(writeGroupNoun({ kind: "template", pageIds: [] })).toBe("template page");
    expect(writeGroupNoun({ kind: "model", pageIds: [] })).toBe("page");
  });

  test("reads the template pages of a structure checkpoint", () => {
    const checkpoint = JSON.stringify({
      sections: [
        {
          id: "api",
          title: "REST API",
          pages: [
            {
              id: "users",
              title: "Users",
              description: "The users group.",
              reference: { kind: "rest", groupId: "users" },
            },
            {
              id: "list-users",
              title: "List users",
              description: "List users.",
              reference: { kind: "rest", groupId: "users", endpointId: "list-users" },
            },
          ],
        },
        {
          id: "guides",
          title: "Guides",
          default: true,
          pages: [{ id: "start", title: "Start", description: "Start here." }],
        },
      ],
    });

    expect(templatePageIdsOf(checkpoint)).toEqual(["api/list-users"]);
  });

  test("treats every page as a model page when the checkpoint cannot be read", () => {
    expect(templatePageIdsOf("{not json")).toEqual([]);
    expect(templatePageIdsOf(JSON.stringify({ pages: [] }))).toEqual([]);
  });
});
