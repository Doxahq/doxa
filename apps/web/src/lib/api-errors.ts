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
    /** `error.details` of the body, for answers such as 402 `credits_exhausted`. */
    readonly details: unknown = null,
    /**
     * False when the body is not an API error body, for example an HTML 404
     * from a proxy or tunnel that did not send the request to the API.
     */
    readonly fromApi: boolean = true,
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
  if (!parsed.success) return new ApiRequestError(fallback, status, null, null, false)

  const { error } = parsed.data
  if (typeof error === "string") return new ApiRequestError(error, status, null)

  const message = error.message || fallback
  const validation = validationErrorBodySchema.safeParse(error.details)
  if (validation.success) return new ApiValidationError(message, status, validation.data.issues)

  const code = errorCodeSchema.safeParse(error.details)
  return new ApiRequestError(message, status, code.success ? code.data.code : null, error.details ?? null)
}

export function isApiValidationError(error: unknown): error is ApiValidationError {
  return error instanceof ApiValidationError
}
