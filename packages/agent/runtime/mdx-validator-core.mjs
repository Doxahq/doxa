import { compile } from "@mdx-js/mdx";
import { parseRuntimeMdx } from "@doxahq/mdx-runtime";

export const SNIPPET_RADIUS = 2;

function buildSnippet(source, line) {
  if (line <= 0) return "";
  const lines = source.split("\n");
  const start = Math.max(0, line - 1 - SNIPPET_RADIUS);
  const end = Math.min(lines.length, line + SNIPPET_RADIUS);
  return lines.slice(start, end).join("\n");
}

export async function validateMdxSource(source) {
  try {
    await compile(source, { development: false });
  } catch (error) {
    const line = error?.line ?? error?.place?.start?.line ?? 0;
    const col = error?.column ?? error?.place?.start?.column ?? 0;
    return {
      ok: false,
      errors: [{
        rule: error?.ruleId ?? "mdx-parse",
        severity: "hard",
        line,
        col,
        message: error?.reason ?? error?.message ?? "MDX compile failed",
        snippet: buildSnippet(source, line),
      }],
    };
  }

  try {
    parseRuntimeMdx(source);
  } catch (error) {
    return {
      ok: false,
      errors: [{
        rule: "mdx-runtime-incompatible",
        severity: "hard",
        line: 0,
        col: 0,
        message: error?.message ?? "MDX is incompatible with the runtime renderer",
        snippet: "",
      }],
    };
  }

  return { ok: true };
}
