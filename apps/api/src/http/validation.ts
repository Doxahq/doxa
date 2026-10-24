import type { ApiContext } from "./app";
import { parseJson, isResponse } from "./body";
import { error } from "./response";

interface JsonSchema<T> {
  safeParse(value: unknown): ParseResult<T>;
}

type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { flatten(): unknown } };

type JsonParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

export async function parseValidatedJson<T>(
  context: ApiContext,
  schema: JsonSchema<T>,
  invalidMessage: string,
): Promise<JsonParseResult<T>> {
  const body = await parseJson<unknown>(context.req.raw);
  if (isResponse(body)) return { ok: false, response: body };

  const input = schema.safeParse(body);
  if (!input.success) {
    return { ok: false, response: error(invalidMessage, 400, input.error.flatten()) };
  }

  return { ok: true, data: input.data };
}
