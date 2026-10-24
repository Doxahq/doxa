import type {
  ParsedSpec,
  RejectedSpec,
  SpecReaderInput,
  SpecReaderOutput,
} from "@doxahq/contracts/spec-reader";
import { readSpecs } from "../src/read-specs";

export const TEST_READER_VERSION = "test-reader-version";

export function read(files: Record<string, string>, extra: Partial<SpecReaderInput> = {}): SpecReaderOutput {
  return readSpecs({ roots: [Object.keys(files)[0]!], files, ...extra }, TEST_READER_VERSION);
}

/** The single parsed spec of a call, or a failed test. */
export function parsed(files: Record<string, string>, extra: Partial<SpecReaderInput> = {}): ParsedSpec {
  const output = read(files, extra);
  if (output.status !== "read") throw new Error(`Expected a read result, got ${output.status}.`);
  const [spec] = output.specs;
  if (spec?.outcome !== "parsed") throw new Error(`Expected a parsed spec, got ${JSON.stringify(spec)}.`);
  return spec;
}

export function rejected(files: Record<string, string>): RejectedSpec {
  const output = read(files);
  if (output.status !== "read") throw new Error(`Expected a read result, got ${output.status}.`);
  const [spec] = output.specs;
  if (spec?.outcome !== "rejected") throw new Error(`Expected a rejected spec, got ${JSON.stringify(spec)}.`);
  return spec;
}

/** A minimal OpenAPI 3.1 YAML document with the given paths block, indented by two spaces. */
export function openapi(paths: string, rest = ""): string {
  return `openapi: 3.1.0\ninfo: { title: Test API, version: "1" }\npaths:\n${paths}\n${rest}`;
}
