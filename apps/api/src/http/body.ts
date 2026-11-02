import type { z } from "zod";
import { readBoundedBody, RequestBodyTooLarge } from "./bounded-body";
import { error } from "./response";

/**
 * The largest JSON body that a route reads by default. It is larger than any
 * JSON body that the dashboard or an agent sends. A route that takes more,
 * such as content edits or uploads, reads its body with `readBoundedBody`.
 */
export const JSON_BODY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The body as text, read up to `maxBytes`. Throws `RequestBodyTooLarge`
 * after that, which the app answers with 413.
 */
export async function readBodyText(
  request: Request,
  maxBytes: number = JSON_BODY_MAX_BYTES,
): Promise<string> {
  return new TextDecoder().decode(await readBoundedBody(request, maxBytes));
}

export async function parseJson<T>(request: Request): Promise<T | Response> {
  let text: string;
  try {
    text = await readBodyText(request);
  } catch (cause) {
    if (cause instanceof RequestBodyTooLarge) return requestBodyTooLarge();
    throw cause;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return error("Request body must be valid JSON.", 400);
  }
}

export function requestBodyTooLarge(): Response {
  return error("Request body is too large.", 413);
}

export function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

interface ValidBodyOptions {
  /** An empty body reads as `{}`, for routes whose fields are all optional. */
  readonly optional?: boolean;
}

/** The body parsed and checked by `schema`; null when it is not JSON or does not match. */
export async function readValidBody<T extends z.ZodType>(
  request: Request,
  schema: T,
  { optional = false }: ValidBodyOptions = {},
): Promise<z.output<T> | null> {
  const text = await readBodyText(request);
  const value = text.trim().length === 0 ? (optional ? {} : undefined) : parseJsonText(text);
  if (value === undefined) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Undefined when the text is not JSON. */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
