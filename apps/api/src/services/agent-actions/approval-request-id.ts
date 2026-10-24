import { z } from "zod";

export type ApprovalRequestId = string & {
  readonly __brand: "ApprovalRequestId";
};

const approvalRequestIdSchema = z.uuid();

// The only cast to the brand. Stores and parsers build IDs through these
// helpers, so a raw string never passes as a request ID silently.
export function toApprovalRequestId(value: string): ApprovalRequestId {
  return value as ApprovalRequestId;
}

/** Null for a value that cannot name a request, so callers answer "not found". */
export function parseApprovalRequestId(value: string): ApprovalRequestId | null {
  return approvalRequestIdSchema.safeParse(value).success
    ? toApprovalRequestId(value)
    : null;
}
