import { approvalRequestStatusSchema, approvalRequestSummarySchema } from "@doxahq/contracts/approval-requests";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import { READ_ONLY_ANNOTATIONS } from "../shared";

export const listApprovalRequestsTool = defineMcpTool({
  name: "list_approval_requests",
  title: "List approval requests",
  description: "Lists the approval requests that this connection made, newest first.",
  scope: null,
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z
    .object({ status: approvalRequestStatusSchema.optional().describe("Only requests in this status.") })
    .strict(),
  output: z.object({ requests: z.array(approvalRequestSummarySchema) }).strict(),
  async run(context, input) {
    return { requests: await context.actions.listRequests(input.status) };
  },
});
