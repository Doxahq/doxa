import type { z } from "zod";
import { error } from "./response";

export async function parseJson<T>(request: Request): Promise<T | Response> {
  try {
    return (await request.json()) as T;
  } catch {
    return error("Request body must be valid JSON.", 400);
  }
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
  const text = await request.text();
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
