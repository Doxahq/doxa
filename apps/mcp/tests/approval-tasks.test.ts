import type { Client } from "@modelcontextprotocol/client";
import {
  CreateTaskResultV2Schema,
  DetailedTaskV2Schema,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { approvalTask } from "../src/tasks/approval-task";
import {
  APPROVAL_URL,
  detail,
  fakeApprovalRow,
  PENDING_REQUEST_ID,
  type FakeApprovalRow,
} from "./support/fake-actions-rpc";
import { BRANCH_ID, GENERATION_ID, generationDetail, PROJECT_A } from "./support/fixtures";
import { createHarness, REQUEST_ID, type Harness } from "./support/harness";
import {
  callTool,
  modernRequest,
  modernToolCallRequest,
  rpcResponse,
  TASKS_CLIENT_CAPABILITIES,
} from "./support/tool-calls";

const PUBLISH = { projectId: PROJECT_A, branchId: BRANCH_ID, summary: "Add rate-limit docs." };
const PUBLICATION = { publicationId: "pub-1", versionNumber: 4 };
const EMPTY_RESULT = z.object({});

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()),
});

/** Starts `publish_branch` as a Tasks client: a raw call, as the SDK client cannot read a task result. */
async function startPublishTask(harness: Harness) {
  const response = await harness.fetch(modernToolCallRequest("publish_branch", PUBLISH, TASKS_CLIENT_CAPABILITIES));
  const body = await rpcResponse(response);
  if (!("result" in body)) throw new Error(`Expected a result, got ${JSON.stringify(body)}`);
  return body.result;
}

async function tasksClient(harness: Harness): Promise<Client> {
  return harness.connect("modern", TASKS_CLIENT_CAPABILITIES);
}

function getTask(client: Client, taskId = PENDING_REQUEST_ID) {
  return client.request({ method: "tasks/get", params: { taskId } }, DetailedTaskV2Schema);
}

function decide(row: FakeApprovalRow, change: Partial<typeof row.detail>) {
  row.detail = { ...row.detail, decidedAt: "2026-10-04T12:05:00.000Z", ...change };
}

describe("approvalTask", () => {
  const source = (status: Parameters<typeof detail>[0]) => ({ request: detail(status), approvalUrl: APPROVAL_URL });

  it("waits in input_required with the approval link as a URL elicitation", () => {
    expect(approvalTask(source("pending"), REQUEST_ID)).toEqual({
      taskId: PENDING_REQUEST_ID,
      status: "input_required",
      statusMessage: `Waiting for a person to approve the request at ${APPROVAL_URL}.`,
      createdAt: "2026-10-04T12:00:00.000Z",
      lastUpdatedAt: "2026-10-04T12:00:00.000Z",
      ttlMs: null,
      pollIntervalMs: 10_000,
      inputRequests: {
        approval: {
          method: "elicitation/create",
          params: { mode: "url", message: 'Approve "Publish 2 changes from agent-docs" in Doxa.', url: APPROVAL_URL },
        },
      },
    });
  });

  it("works while the approved action runs", () => {
    expect(approvalTask(source("executing"), REQUEST_ID)).toMatchObject({ status: "working" });
  });

  it("completes with the result the tool would have returned", () => {
    const task = approvalTask(
      { request: { ...detail("completed"), result: PUBLICATION, completedAt: "2026-10-04T12:06:00.000Z" }, approvalUrl: APPROVAL_URL },
      REQUEST_ID,
    );
    expect(task).toMatchObject({
      status: "completed",
      lastUpdatedAt: "2026-10-04T12:06:00.000Z",
      result: { structuredContent: { outcome: "completed", result: PUBLICATION } },
    });
  });

  it.each([
    ["rejected", { decisionNote: "Not yet." }, "request_rejected", "The user rejected the request: Not yet."],
    ["expired", {}, "request_expired", "Nobody decided the request before it expired."],
    ["stale", { error: { code: "main_moved", message: "The live site changed." } }, "stale", "The live site changed."],
    ["failed", { error: { code: "internal_error", message: "The publish failed." } }, "action_failed", "The publish failed."],
  ] as const)("completes a %s request with the tool error", (status, change, code, message) => {
    const task = approvalTask({ request: { ...detail(status), ...change }, approvalUrl: APPROVAL_URL }, REQUEST_ID);
    expect(task).toMatchObject({
      status: "completed",
      statusMessage: message,
      result: { isError: true, structuredContent: { error: { code, message, requestId: REQUEST_ID } } },
    });
  });

  it("cancels with the request", () => {
    expect(approvalTask(source("cancelled"), REQUEST_ID)).toMatchObject({ status: "cancelled" });
  });
});

describe("MCP Tasks for gated actions (2026-07-28 clients that declare Tasks)", () => {
  it("advertises the Tasks extension only to 2026 clients", async () => {
    const harness = createHarness();
    const modern = await harness.connect("modern");
    const legacy = await harness.connect("legacy");
    expect(modern.getServerCapabilities()?.extensions).toEqual({ "io.modelcontextprotocol/tasks": {} });
    expect(legacy.getServerCapabilities()?.extensions).toBeUndefined();
  });

  it("returns a task that waits in input_required, then completes after approval without polling get_approval_request", async () => {
    const approval = fakeApprovalRow();
    const harness = createHarness({ approval });

    const created = CreateTaskResultV2Schema.parse(await startPublishTask(harness));
    expect(created).toMatchObject({ resultType: "task", taskId: PENDING_REQUEST_ID, status: "input_required" });

    const client = await tasksClient(harness);
    const waiting = await getTask(client);
    expect(waiting).toMatchObject({
      status: "input_required",
      inputRequests: { approval: { method: "elicitation/create", params: { mode: "url", url: APPROVAL_URL } } },
    });

    // The client answers the link elicitation; the task keeps waiting for the person.
    const update = await client.request(
      { method: "tasks/update", params: { taskId: PENDING_REQUEST_ID, inputResponses: { approval: { action: "accept" } } } },
      EMPTY_RESULT,
    );
    expect(update).toEqual({});
    expect(await getTask(client)).toEqual(waiting);

    decide(approval, { status: "executing" });
    expect(await getTask(client)).toMatchObject({ status: "working" });

    decide(approval, { status: "completed", result: PUBLICATION, completedAt: "2026-10-04T12:06:00.000Z" });
    const completed = await getTask(client);
    if (completed.status !== "completed") throw new Error(`Expected completed, got ${completed.status}`);
    expect(toolResultSchema.parse(completed.result)).toEqual({
      structuredContent: { outcome: "completed", result: PUBLICATION },
    });

    expect(harness.actionCalls).toHaveLength(1);
    expect(harness.toolCalls.map((entry) => entry.tool)).toEqual(["publish_branch"]);
  });

  it("answers an action the policy allows with its result, not a task", async () => {
    const generation = generationDetail(PROJECT_A);
    const harness = createHarness({
      actions: {
        "generation.cancel": { ok: true, value: { outcome: "completed", result: { generation }, policySource: "action_default" } },
      },
    });
    const response = await harness.fetch(
      modernToolCallRequest("cancel_generation", { projectId: PROJECT_A, generationId: GENERATION_ID }, TASKS_CLIENT_CAPABILITIES),
    );
    const body = await rpcResponse(response);
    expect(body).toMatchObject({ result: { resultType: "complete", structuredContent: { outcome: "completed" } } });
    expect(body).not.toHaveProperty("result.taskId");
  });

  it("keeps the v1 result in the task result for clients that read only the content", async () => {
    const result = await startPublishTask(createHarness());
    expect(result).toMatchObject({
      structuredContent: { outcome: "approval_required", request: { id: PENDING_REQUEST_ID, approvalUrl: APPROVAL_URL } },
    });
  });

  it("completes a rejected request with the rejection as a tool error", async () => {
    const approval = fakeApprovalRow();
    const harness = createHarness({ approval });
    await startPublishTask(harness);
    decide(approval, { status: "rejected", decisionNote: "Wait for the release." });
    const task = await getTask(await tasksClient(harness));
    if (task.status !== "completed") throw new Error(`Expected completed, got ${task.status}`);
    expect(toolResultSchema.parse(task.result)).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "request_rejected", message: "The user rejected the request: Wait for the release." },
      },
    });
  });

  it("cancels the approval request on tasks/cancel", async () => {
    const approval = fakeApprovalRow();
    const harness = createHarness({ approval });
    await startPublishTask(harness);
    const client = await tasksClient(harness);
    const cancel = () => client.request({ method: "tasks/cancel", params: { taskId: PENDING_REQUEST_ID } }, EMPTY_RESULT);
    expect(await cancel()).toEqual({});
    expect(approval.detail.status).toBe("cancelled");
    expect(await getTask(client)).toMatchObject({ status: "cancelled" });
    // Cooperative: a task that already ended acknowledges and keeps its outcome.
    expect(await cancel()).toEqual({});
  });

  it("answers -32602 for a task of another client or an unknown ID", async () => {
    const harness = createHarness();
    const response = await harness.fetch(
      modernRequest("tasks/get", BRANCH_ID, { taskId: BRANCH_ID }, TASKS_CLIENT_CAPABILITIES),
    );
    expect(await rpcResponse(response)).toEqual({
      error: { code: -32602, message: "Failed to retrieve task: Task not found" },
    });
  });

  it("answers -32021 to tasks/get from a client that does not declare Tasks", async () => {
    const harness = createHarness();
    const response = await harness.fetch(modernRequest("tasks/get", PENDING_REQUEST_ID, { taskId: PENDING_REQUEST_ID }));
    expect(await rpcResponse(response)).toMatchObject({
      error: {
        code: -32021,
        data: { requiredCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } },
      },
    });
  });

  it("falls back to the v1 result when doxa-api cannot show the request as a task", async () => {
    const approval = fakeApprovalRow();
    approval.detail = { ...approval.detail, id: BRANCH_ID };
    const harness = createHarness({ approval });
    const result = await startPublishTask(harness);
    expect(result).not.toHaveProperty("resultType", "task");
    expect(result).toMatchObject({ structuredContent: { outcome: "approval_required" } });
    expect(harness.failures).toEqual([expect.objectContaining({ event: "mcp_task_create_failed" })]);
  });
});

describe("clients without Tasks keep the v1 approval flow", () => {
  it.each(["modern", "legacy"] as const)("a %s client gets approval_required and polls get_approval_request", async (mode) => {
    const approval = fakeApprovalRow();
    const harness = createHarness({ approval });
    const client = await harness.connect(mode);
    const outcome = await callTool(client, "publish_branch", PUBLISH);
    expect(outcome).toEqual({
      isError: false,
      structured: {
        outcome: "approval_required",
        request: expect.objectContaining({ id: PENDING_REQUEST_ID, approvalUrl: APPROVAL_URL, pollAfterMs: 10_000 }),
        message: expect.any(String),
      },
    });
    decide(approval, { status: "completed", result: PUBLICATION });
    const polled = await callTool(client, "get_approval_request", { requestId: PENDING_REQUEST_ID });
    expect(polled.structured).toMatchObject({ status: "completed", result: PUBLICATION });
  });

  it("serves no tasks/get to a 2025 client", async () => {
    const harness = createHarness();
    const client = await harness.connect("legacy");
    await expect(
      client.request({ method: "tasks/get", params: { taskId: PENDING_REQUEST_ID } }, DetailedTaskV2Schema),
    ).rejects.toThrow();
  });
});
