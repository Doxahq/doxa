import {
  SPEC_READER_LIMITS,
  type SkippedSpecOperation,
  type SpecOperation,
  type SpecSkipCode,
} from "@doxahq/contracts/spec-reader";
import {
  arrayAt,
  isSpecObject,
  stringAt,
  valueAt,
  type SpecObject,
  type SpecValue,
} from "../document/tree";
import type { ReferenceResolver } from "../references/resolver";
import { readRequestBody, readResponses } from "./bodies";
import type { CollectedOperation } from "./operations";
import { skippedOperation } from "./operations";
import { readParameters } from "./parameters";
import { readSecurity } from "./security";
import { specName, specText } from "./text";

export interface OperationContext {
  resolver: ReferenceResolver;
  rootSecurity: SpecValue | undefined;
  knownSchemes: ReadonlySet<string>;
}

export type OperationResult =
  | { ok: true; operation: SpecOperation }
  | { ok: false; skipped: SkippedSpecOperation };

/** The facts of one operation, or the reason gate G2 skips it. */
export function readOperation(collected: CollectedOperation, context: OperationContext): OperationResult {
  const { method, path, operation } = collected;
  const skip = (code: SpecSkipCode, message: string): OperationResult => ({
    ok: false,
    skipped: skippedOperation(method, path, code, message),
  });

  const responses = valueAt(operation.value, "responses");
  if (responses !== undefined && !isSpecObject(responses)) {
    return skip("invalid_responses", "The responses are not an object.");
  }
  const operationParameters = valueAt(operation.value, "parameters");
  const parameters = readParameters(path, [
    collected.pathItemParameters,
    operationParameters === undefined ? undefined : { value: operationParameters, file: operation.file },
  ], context.resolver);
  if (!parameters.ok) return skip(parameters.code, parameters.message);

  const result: SpecOperation = {
    method,
    path,
    deprecated: valueAt(operation.value, "deprecated") === true,
    parameters: parameters.parameters,
    responses: readResponses(operation, context.resolver),
  };
  const tag = firstTag(operation.value);
  if (tag) result.tag = tag;
  const summary = specText(stringAt(operation.value, "summary"), SPEC_READER_LIMITS.maxTitleChars);
  if (summary) result.summary = summary;
  const description = specText(stringAt(operation.value, "description"), SPEC_READER_LIMITS.maxDescriptionChars);
  if (description) result.description = description;
  const requestBody = readRequestBody(operation, context.resolver);
  if (requestBody) result.requestBody = requestBody;
  const security = readSecurity(valueAt(operation.value, "security"), context.rootSecurity, context.knownSchemes);
  if (security) result.security = security;
  return { ok: true, operation: result };
}

/** The first valid tag of an operation, which names its group. */
export function firstTag(operation: SpecObject): string | undefined {
  for (const tag of arrayAt(operation, "tags") ?? []) {
    const name = specName(tag);
    if (name) return name;
  }
  return undefined;
}
