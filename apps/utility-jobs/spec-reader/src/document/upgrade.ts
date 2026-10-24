import { SPEC_READER_LIMITS } from "@doxahq/contracts/spec-reader";
import { upgrade } from "@scalar/openapi-upgrader";
import { toSpecTree } from "./safe-tree";
import { isSpecObject, type SpecObject } from "./tree";
import type { SpecVersion } from "./version";

/**
 * Brings a Swagger 2.0 or OpenAPI 3.0 root into the OpenAPI 3.1 shape, so
 * the mapper reads one shape. A 3.1 or 3.2 root stays as it is: 3.2 only
 * adds to 3.1. The upgrade is a pure function of the document.
 */
export function toOpenApi31Shape(document: SpecObject, version: SpecVersion): SpecObject | undefined {
  if (version.family === "openapi-3.1" || version.family === "openapi-3.2") return document;

  const upgraded = toSpecTree(upgrade(document, "3.1"), SPEC_READER_LIMITS.maxDocumentDepth);
  return isSpecObject(upgraded) ? upgraded : undefined;
}
