import {
  applyDocsContentEditsInputSchema,
  DOCS_CONTENT_MAX_PAGE_BYTES,
} from "@doxahq/contracts";
import {
  createValidationIssue,
  parseSiteConfigStrict,
  SITE_CONFIG_LIMITS,
  type ValidationIssue,
} from "@doxahq/site-config";
import { readBoundedBody, RequestBodyTooLarge } from "./bounded-body";
import { error, validationError } from "./response";

function stringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return index + 1;
  }
  return text.length;
}

function valueEnd(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      index = stringEnd(text, index) - 1;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      if (--depth <= 0) return index + (depth === 0 ? 1 : 0);
    } else if (char === "," && depth === 0) return index;
  }
  return text.length;
}

/** Measure raw config values before JSON.parse, including escaped property names. */
export function containsOversizedConfig(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '"') continue;
    const end = stringEnd(text, index);
    let separator = end;
    while (/\s/.test(text[separator] ?? "!")) separator++;
    if (text[separator] === ":" && end - index <= 40) {
      let key: unknown;
      try {
        key = JSON.parse(text.slice(index, end));
      } catch {
        return false;
      }
      if (key === "config") {
        let start = separator + 1;
        while (/\s/.test(text[start] ?? "!")) start++;
        if (
          new TextEncoder().encode(text.slice(start, valueEnd(text, start)))
            .byteLength > SITE_CONFIG_LIMITS.configBytes
        )
          return true;
      }
    }
    index = end - 1;
  }
  return false;
}

export async function parseContentEdits(request: Request) {
  let input: unknown;
  try {
    const bytes = await readBoundedBody(
      request,
      100 * (DOCS_CONTENT_MAX_PAGE_BYTES + SITE_CONFIG_LIMITS.configBytes),
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (containsOversizedConfig(text))
      return {
        ok: false,
        response: validationError([createValidationIssue("config_too_large")]),
      } as const;
    input = JSON.parse(text);
  } catch (cause) {
    return {
      ok: false,
      response: error(
        cause instanceof RequestBodyTooLarge
          ? "Request body is too large."
          : "Request body must be valid JSON.",
        cause instanceof RequestBodyTooLarge ? 413 : 400,
      ),
    } as const;
  }
  const issues: ValidationIssue[] = [];
  if (
    input &&
    typeof input === "object" &&
    "edits" in input &&
    Array.isArray(input.edits)
  ) {
    for (const edit of input.edits) {
      if (
        edit &&
        typeof edit === "object" &&
        "type" in edit &&
        edit.type === "set_site_config"
      ) {
        const result = parseSiteConfigStrict(
          "config" in edit ? edit.config : undefined,
        );
        if (!result.ok) issues.push(...result.issues);
      }
    }
  }
  if (issues.length)
    return { ok: false, response: validationError(issues) } as const;
  const parsed = applyDocsContentEditsInputSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      response: error("Invalid docs content edit payload.", 400),
    } as const;
  return { ok: true, data: parsed.data } as const;
}
