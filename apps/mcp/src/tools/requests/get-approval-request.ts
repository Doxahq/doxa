import { approvalRequestDetailSchema } from "@doxahq/contracts/approval-requests";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import { READ_ONLY_ANNOTATIONS } from "../shared";
import { requestIdInput } from "./request-id";

export const getApprovalRequestTool = defineMcpTool({
  name: "get_approval_request",
  title: "Get an approval request",
  description:
    "Returns the status of an approval request that this connection made: pending, completed (with the result), rejected (with the reason), stale, expired, cancelled, or failed. While it is pending, wait pollAfterMs (10 seconds) between calls.",
  scope: null,
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z.object({ requestId: requestIdInput }).strict(),
  output: approvalRequestDetailSchema,
  run: (context, input) => context.actions.getRequest(input.requestId),
});
