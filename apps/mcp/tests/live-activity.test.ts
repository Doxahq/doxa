import { agentActor } from "@doxahq/api/services/agent-access/actor";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { liveBranchId, liveEventFor } from "../src/live-activity";
import type { McpRequestContext } from "../src/request-context";
import { defineMcpTool } from "../src/tool-definition";
import { runTool } from "../src/tool-runner";
import type { DocsPageChange } from "@doxahq/api/services/docs-content/page-changes";
import { describeDocsEdits, MAX_EDIT_ACTIVITIES } from "../src/tools/docs/edit-activity";
import { BRANCH_ID, GRANT_REF, OWNER, PROJECT_A, PROJECT_B, PROJECT_OTHER } from "./support/fixtures";
import { createHarness } from "./support/harness";
import { callTool } from "./support/tool-calls";

const actor = agentActor({
  userId: OWNER,
  clientId: "client-1",
  clientName: "Agent‮\nname",
  grantRef: GRANT_REF,
  scopes: ["docs:read"],
  projectScope: { kind: "all" },
});

const SHARED = { branchId: BRANCH_ID, note: null, branchRevision: 3 };

function pageChange(overrides: Partial<DocsPageChange> & { href: string }): DocsPageChange {
  return { movedFrom: null, isNew: false, linesAdded: 0, linesRemoved: 0, diff: null, ...overrides };
}

describe("liveEventFor", () => {
  it("cleans every text that the agent chose", () => {
    const event = liveEventFor(actor, "search_docs", { kind: "search", detail: `a⁦b\n${"x".repeat(400)}` });
    expect(event.clientName).toBe("Agent name");
    expect(event.detail).toHaveLength(200);
    expect(event.detail?.startsWith("ab x")).toBe(true);
  });

  it("never stores main as a branch", () => {
    expect(liveBranchId("main")).toBeNull();
    expect(liveBranchId(undefined)).toBeNull();
    expect(liveBranchId(BRANCH_ID)).toBe(BRANCH_ID);
  });
});

describe("describeDocsEdits", () => {
  it("gives one line per page and one for structure changes", () => {
    const activities = describeDocsEdits(
      [
        { type: "set_page_content", href: "/a" },
        { type: "set_page_icon", href: "/a" },
        { type: "create_page" },
        { type: "create_group" },
        { type: "delete_group" },
      ],
      SHARED,
      [pageChange({ href: "/guides/new", isNew: true })],
    );
    expect(activities).toEqual([
      { kind: "edit", ...SHARED, pageHref: "/guides/new" },
      { kind: "edit", ...SHARED, pageHref: "/a" },
      { kind: "edit", ...SHARED, detail: "Site structure" },
    ]);
  });

  it("summarizes the pages over the limit", () => {
    const edits = Array.from({ length: MAX_EDIT_ACTIVITIES + 3 }, (_, index) => ({
      type: "reset_page",
      href: `/page-${index}`,
    }));
    const activities = describeDocsEdits(edits, SHARED, []);
    expect(activities).toHaveLength(MAX_EDIT_ACTIVITIES + 1);
    expect(activities.at(-1)?.detail).toBe("3 more pages");
  });

  it("reports a renamed or moved page at its new href", () => {
    const activities = describeDocsEdits(
      [{ type: "rename_page", href: "/old" }],
      SHARED,
      [pageChange({ href: "/new", movedFrom: "/old" })],
    );
    expect(activities).toEqual([{ kind: "edit", ...SHARED, pageHref: "/new" }]);
  });

  it("uses the normal form of an href", () => {
    const activities = describeDocsEdits([{ type: "set_page_content", href: "guides/setup/" }], SHARED, []);
    expect(activities).toEqual([{ kind: "edit", ...SHARED, pageHref: "/guides/setup" }]);
  });

  it("still shows a new page whose change was not recorded", () => {
    const activities = describeDocsEdits([{ type: "create_page" }], SHARED, []);
    expect(activities).toEqual([{ kind: "edit", ...SHARED, detail: "Site structure" }]);
  });
});

describe("live events from tool calls", () => {
  it("records a read and a page edit through the real tools", async () => {
    const harness = createHarness();
    const client = await harness.connect("modern");
    await callTool(client, "read_page", { projectId: PROJECT_A, href: "/quickstart" });
    await harness.settle();
    expect(harness.liveEvents).toEqual([
      expect.objectContaining({
        projectId: PROJECT_A,
        tool: "read_page",
        kind: "read",
        pageHref: "/quickstart",
        branchId: null,
        grantRef: GRANT_REF,
      }),
    ]);
  });

  it("writes nothing for a project outside the grant", async () => {
    const harness = createHarness();
    const client = await harness.connect("modern");
    const outcome = await callTool(client, "read_page", { projectId: PROJECT_OTHER, href: "/quickstart" });
    await harness.settle();
    expect(outcome.isError).toBe(true);
    expect(harness.liveEvents).toEqual([]);
  });
});

describe("per-edit detail", () => {
  it("adds the note, the diff, and the line counts of the changed page", async () => {
    const harness = createHarness({
      services: (fakes) => ({
        ...fakes,
        docs: {
          ...fakes.docs,
          applyEdits: async (actorArg, project, edits, branch, options) => {
            options?.onPagesChanged?.([pageChange({ href: "/install", linesAdded: 2, linesRemoved: 1, diff: "+new" })]);
            return fakes.docs.applyEdits(actorArg, project, edits, branch, options);
          },
        },
      }),
    });
    const client = await harness.connect("modern");
    const outcome = await callTool(client, "write_page", {
      projectId: PROJECT_A,
      branch: BRANCH_ID,
      href: "install/",
      content: "---\ntitle: Install\n---\n\nRun it.\n",
      note: "Fix\u202E the steps",
    });
    await harness.settle();
    expect(outcome.isError).toBe(false);
    expect(harness.liveEvents).toEqual([
      expect.objectContaining({
        kind: "edit",
        branchId: BRANCH_ID,
        pageHref: "/install",
        note: "Fix the steps",
        linesAdded: 2,
        linesRemoved: 1,
        diff: "+new",
        branchRevision: expect.any(Number),
      }),
    ]);
  });

  it("refuses a note over the limit", async () => {
    const harness = createHarness();
    const client = await harness.connect("modern");
    const result = await client.callTool({
      name: "write_page",
      arguments: {
        projectId: PROJECT_A,
        branch: BRANCH_ID,
        href: "/install",
        content: "x",
        note: "n".repeat(201),
      },
    });
    expect(result.isError).toBe(true);
    await harness.settle();
    expect(harness.liveEvents).toEqual([]);
  });
});

describe("the project of a live event", () => {
  const input = z.object({ projectId: z.string() }).strict();
  const output = z.object({ ok: z.boolean() }).strict();
  const describeActivity = () => [{ kind: "read" as const }];

  function contextWith(append: McpRequestContext["liveEvents"]["append"]) {
    const pending: Promise<unknown>[] = [];
    const failure = vi.fn();
    const context = {
      requestId: "request-1",
      actor,
      policy: {
        authorize: async () => ({ allowed: true, project: { projectId: PROJECT_B } }),
        listAccessibleProjects: async () => [],
      },
      limiter: { allow: async () => true },
      activity: { append: async () => undefined },
      liveEvents: { append },
      logger: { toolCall: vi.fn(), failure },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      now: () => 0,
    } as unknown as McpRequestContext;
    return { context, pending, failure };
  }

  const base = {
    title: "Probe",
    description: "Test tool.",
    scope: null,
    cost: "read" as const,
    annotations: {},
    input,
    output,
    describeActivity,
  };

  it("comes from the access policy, never from the raw input", async () => {
    const append = vi.fn(async () => undefined);
    const { context, pending } = contextWith(append);
    const tool = defineMcpTool({
      ...base,
      name: "probe",
      async run(toolContext) {
        await toolContext.authorize(PROJECT_A, "docs.read");
        return { ok: true };
      },
    });
    await runTool(tool, context, { projectId: PROJECT_A });
    await Promise.all(pending);
    expect(append).toHaveBeenCalledWith(PROJECT_B, expect.any(Array));
  });

  it("is absent when a tool never passed the policy", async () => {
    const append = vi.fn(async () => undefined);
    const { context, pending } = contextWith(append);
    const tool = defineMcpTool({ ...base, name: "probe", run: async () => ({ ok: true }) });
    await runTool(tool, context, { projectId: PROJECT_A });
    await Promise.all(pending);
    expect(append).not.toHaveBeenCalled();
  });

  it("logs a failed write and keeps the tool result", async () => {
    const { context, pending, failure } = contextWith(async () => {
      throw new Error("database down");
    });
    const tool = defineMcpTool({
      ...base,
      name: "probe",
      async run(toolContext) {
        await toolContext.authorize(PROJECT_A, "docs.read");
        return { ok: true };
      },
    });
    const result = await runTool(tool, context, { projectId: PROJECT_A });
    await Promise.all(pending);
    expect(result.isError).toBeFalsy();
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mcp_live_event_write_failed", errorName: "Error", stack: null }),
    );
  });
});
