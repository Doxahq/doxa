import {
  SPEC_FILE_ISSUE_MESSAGES,
  SPEC_READER_LIMITS,
  type ParsedSpec,
  type RejectedSpec,
  type SkippedSpecOperation,
  type SpecOperation,
  type SpecReadOutcome,
  type SpecRejectionCode,
} from "@doxahq/contracts/spec-reader";
import type { SpecFiles } from "./document/spec-files";
import { isSpecObject, objectAt, stringAt, valueAt, type SpecObject } from "./document/tree";
import { toOpenApi31Shape } from "./document/upgrade";
import { detectSpecVersion } from "./document/version";
import { readOperation } from "./mapping/operation";
import { firstTag } from "./mapping/operation";
import { collectOperations } from "./mapping/operations";
import { readSecuritySchemes } from "./mapping/security";
import { readServers } from "./mapping/servers";
import { orderTags } from "./mapping/tags";
import { specText } from "./mapping/text";
import { ReferenceResolver } from "./references/resolver";

/** Skipped operations that one spec reports; a count of the rest is enough. */
const MAX_REPORTED_SKIPS = 1_000;

/**
 * Reads one root spec file into spec facts: parse, version, upgrade to the
 * 3.1 shape, operations through gate G2, then tags, servers and security.
 * Every failure becomes a rejection with a fixed message, never an error.
 */
export function readSpec(root: string, files: SpecFiles): SpecReadOutcome {
  const lookup = files.lookup(root);
  if (lookup.status === "invalid") {
    return rejected(root, lookup.issue.code, SPEC_FILE_ISSUE_MESSAGES[lookup.issue.reason]);
  }
  if (lookup.status !== "found" || !isSpecObject(lookup.value)) {
    return rejected(root, "parse_failed", "The root file is not a spec object.");
  }

  const version = detectSpecVersion(lookup.value);
  if (!version) {
    return rejected(root, "unsupported_version", "The file is not Swagger 2.0 or OpenAPI 3.0, 3.1 or 3.2.");
  }
  let document: SpecObject | undefined;
  try {
    document = toOpenApi31Shape(lookup.value, version);
  } catch {
    document = undefined;
  }
  if (!document) return rejected(root, "upgrade_failed", `The ${version.text} spec could not be read as OpenAPI 3.1.`);
  files.setDocument(root, document);

  const paths = objectAt(document, "paths");
  if (!paths) return rejected(root, "no_paths", "The spec has no paths.");

  const resolver = new ReferenceResolver(files);
  const located = { value: document, file: root };
  const collected = collectOperations(located, paths, resolver);
  if (!collected.ok) {
    return rejected(root, "too_many_operations", `The spec has more than ${SPEC_READER_LIMITS.maxOperations} operations.`);
  }

  const tags = orderTags(document, collected.operations.flatMap((entry) => firstTag(entry.operation.value) ?? []));
  if (!tags) return rejected(root, "too_many_tags", `The spec has more than ${SPEC_READER_LIMITS.maxTags} tags.`);

  const securitySchemes = readSecuritySchemes(located, resolver);
  const context = {
    resolver,
    rootSecurity: valueAt(document, "security"),
    knownSchemes: new Set(securitySchemes.map((scheme) => scheme.name)),
  };
  const operations: SpecOperation[] = [];
  const skippedOperations: SkippedSpecOperation[] = [...collected.skipped];
  for (const entry of collected.operations) {
    const result = readOperation(entry, context);
    if (result.ok) operations.push(result.operation);
    else skippedOperations.push(result.skipped);
  }
  if (operations.length === 0) {
    return rejected(root, "no_valid_operations", "No operation of the spec passed the checks.");
  }

  return {
    outcome: "parsed",
    root,
    specVersion: version.text,
    files: [root, ...[...resolver.usedFiles].filter((file) => file !== root).sort()],
    info: readInfo(document),
    servers: readServers(document),
    securitySchemes,
    tags,
    operations,
    skippedOperations: skippedOperations.slice(0, MAX_REPORTED_SKIPS),
  } satisfies ParsedSpec;
}

function readInfo(document: SpecObject): ParsedSpec["info"] {
  const info = objectAt(document, "info");
  if (!info) return {};
  const result: ParsedSpec["info"] = {};
  const title = specText(stringAt(info, "title"), SPEC_READER_LIMITS.maxTitleChars);
  if (title) result.title = title;
  const description = specText(stringAt(info, "description"), SPEC_READER_LIMITS.maxDescriptionChars);
  if (description) result.description = description;
  return result;
}

function rejected(root: string, code: SpecRejectionCode, message: string): RejectedSpec {
  return { outcome: "rejected", root, code, message };
}
