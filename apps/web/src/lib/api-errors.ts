import { z } from "zod"
import {
  validationErrorBodySchema,
  type ValidationIssue,
} from "@doxahq/contracts/validation"

/** A failed API request, with the HTTP status and the error code if any. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message)
    this.name = "ApiRequestError"
  }
}

/** A request rejected with field issues (HTTP 422, `validation_failed`). */
export class ApiValidationError extends ApiRequestError {
  constructor(
    message: string,
    status: number,
    readonly issues: readonly ValidationIssue[],
  ) {
    super(message, status, "validation_failed")
    this.name = "ApiValidationError"
  }
}

const apiErrorPayloadSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      message: z.string().optional(),
      details: z.unknown().optional(),
    }),
  ]),
})

const errorCodeSchema = z.object({ code: z.string() })

/**
 * Builds the error for a failed response.
 *
 * Every error keeps the server message, so callers that read `message` see no
 * change. A body with validation issues becomes an `ApiValidationError`.
 */
export function createApiError(status: number, payload: unknown): ApiRequestError {
  const fallback = `Request failed (${status})`
  const parsed = apiErrorPayloadSchema.safeParse(payload)
  if (!parsed.success) return new ApiRequestError(fallback, status, null)

  const { error } = parsed.data
  if (typeof error === "string") return new ApiRequestError(error, status, null)

  const message = error.message || fallback
  const validation = validationErrorBodySchema.safeParse(error.details)
  if (validation.success) return new ApiValidationError(message, status, validation.data.issues)

  const code = errorCodeSchema.safeParse(error.details)
  return new ApiRequestError(message, status, code.success ? code.data.code : null)
}

export function isApiValidationError(error: unknown): error is ApiValidationError {
  return error instanceof ApiValidationError
}
