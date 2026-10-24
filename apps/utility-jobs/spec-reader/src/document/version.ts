import { valueAt, type SpecObject } from "./tree";

export type SpecFamily = "swagger-2.0" | "openapi-3.0" | "openapi-3.1" | "openapi-3.2";

export interface SpecVersion {
  family: SpecFamily;
  /** The version text of the file. */
  text: string;
}

const OPENAPI_VERSION = /^3\.([0-2])(?:\.\d+)?$/;

/**
 * The version of a spec root. YAML reads an unquoted `swagger: 2.0` or
 * `openapi: 3.1` as a number, so a number counts as its text.
 */
export function detectSpecVersion(document: SpecObject): SpecVersion | undefined {
  const swagger = versionText(valueAt(document, "swagger"));
  if (swagger === "2.0" || swagger === "2") return { family: "swagger-2.0", text: "2.0" };

  const openapi = versionText(valueAt(document, "openapi"));
  const minor = openapi?.match(OPENAPI_VERSION)?.[1];
  if (!openapi || minor === undefined) return undefined;
  return { family: familyOf(minor), text: openapi };
}

function familyOf(minor: string): SpecFamily {
  return minor === "0" ? "openapi-3.0" : minor === "1" ? "openapi-3.1" : "openapi-3.2";
}

function versionText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}
