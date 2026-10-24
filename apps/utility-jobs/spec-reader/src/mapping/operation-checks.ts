import { SPEC_READER_LIMITS } from "@doxahq/contracts/spec-reader";
import { hasControlCharacter } from "./text";

/** Path item keys that hold an operation, in OpenAPI order. 3.2 adds `query`. */
export const STANDARD_METHODS: readonly string[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
];

/** A 3.2 `additionalOperations` key: an upper-case HTTP method token. */
const CUSTOM_METHOD = /^[A-Z][A-Z0-9-]{0,19}$/;

/** The characters of an HTTP header name (RFC 9110 token). */
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type ParameterLocation = "path" | "query" | "header" | "cookie" | "querystring";

const PARAMETER_LOCATIONS: ReadonlySet<string> = new Set<ParameterLocation>([
  "path",
  "query",
  "header",
  "cookie",
  "querystring",
]);

export function isCustomMethod(method: string): boolean {
  return CUSTOM_METHOD.test(method);
}

export function isParameterLocation(value: unknown): value is ParameterLocation {
  return typeof value === "string" && PARAMETER_LOCATIONS.has(value);
}

/**
 * Why a path cannot become an endpoint, or undefined when it can: it starts
 * with `/`, has no control characters or spaces, is at most 2,000
 * characters, and every `{name}` is closed and not nested.
 */
export function pathProblem(path: string): string | undefined {
  if (!path.startsWith("/")) return "The path does not start with /.";
  if (path.length > SPEC_READER_LIMITS.maxPathChars) return "The path is too long.";
  if (hasControlCharacter(path) || /\s/.test(path)) return "The path has a control character or a space.";
  let open = false;
  for (const character of path) {
    if (character === "{") {
      if (open) return "The path nests a parameter inside a parameter.";
      open = true;
    } else if (character === "}") {
      if (!open) return "The path closes a parameter that it did not open.";
      open = false;
    }
  }
  if (open) return "The path does not close a parameter.";
  if (/\{\}/.test(path)) return "The path has a parameter with no name.";
  return undefined;
}

/** The `{name}` parameters of a path template, in order. */
export function pathTemplateNames(path: string): string[] {
  return [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!);
}

/** Header parameter names must be HTTP tokens, so they cannot change a code sample. */
export function headerNameProblem(name: string): string | undefined {
  return HTTP_TOKEN.test(name) ? undefined : "The header name has characters that a header cannot have.";
}
