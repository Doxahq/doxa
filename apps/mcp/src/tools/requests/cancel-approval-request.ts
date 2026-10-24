import { approvalRequestDetailSchema } from "@doxahq/contracts/approval-requests";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import { writeAnnotations } from "../shared";
import { requestIdInput } from "./request-id";

export const cancelApprovalRequestTool = defineMcpTool({
  name: "cancel_approval_request",
  title: "Cancel an approval request",
  description: "Withdraws a pending approval request that this connection made.",
  scope: null,
  cost: "write",
  annotations: writeAnnotations(true),
  input: z.object({ requestId: requestIdInput }).strict(),
  output: approvalRequestDetailSchema,
  run: (context, input) => context.actions.cancelRequest(input.requestId),
});
