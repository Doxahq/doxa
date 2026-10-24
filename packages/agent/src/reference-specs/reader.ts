import {
  SPEC_READER_LIMITS,
  type ParsedSpec,
  type SpecReaderInput,
  type SpecReaderResult,
} from "@doxahq/contracts/spec-reader";
import type {
  ReferenceFileIssue,
  ReferenceSourceReport,
  ReferenceSourceStatus,
  ReferenceSpecReport,
  RestApiReferenceSurface,
  SpecReaderCallResult,
  SpecReaderClient,
} from "../types";
import { hashObject } from "../utils/hash";
import { discoverSpecFiles } from "./discovery";
import { readSpecFile } from "./file-gate";
import { checkSpecReaderOutput } from "./output-schema";
import {
  fileIssueReports,
  notReadReport,
  outcomeReport,
  skippedOperationReports,
  type SpecNotReadCode,
  type SpecRequestRefusal,
} from "./report";
import { SecretRedactor } from "./secrets";
import { buildSpecSurface } from "./surface";

export interface RepositorySpecRead {
  /** The REST surface from the specs; absent when the model route must run. */
  surface?: RestApiReferenceSurface;
  report: ReferenceSourceReport;
}

export interface RepositorySpecReadOptions {
  checkoutRoot: string;
  client?: SpecReaderClient;
  /** Spec files named in the project settings. */
  configuredPaths?: readonly string[];
}

/** A job call that did not finish is tried once more before the model route runs. */
const CALL_ATTEMPTS = 2;

/**
 * The spec route of the analysis. It finds spec files, checks each with
 * gate G1, sends them to the spec-reader job, checks the answer with gate
 * G3, and builds the REST surface. A `$ref` to a file that was not sent
 * starts another round, at most four. Every failure ends in a report and
 * the model route, never in an error.
 */
export async function readRepositorySpecs(options: RepositorySpecReadOptions): Promise<RepositorySpecRead> {
  const roots = await discoverSpecFiles(options.checkoutRoot, options.configuredPaths);
  if (roots.length === 0) return modelRoute("no_spec", []);
  if (!options.client) return modelRoute("reader_unavailable", roots.map(notRead("no_reader")));

  try {
    return await readWithClient(options.checkoutRoot, roots, options.client);
  } finally {
    await options.client.done().catch(() => undefined);
  }
}

async function readWithClient(
  checkoutRoot: string,
  roots: readonly string[],
  client: SpecReaderClient,
): Promise<RepositorySpecRead> {
  const request = new SpecRequest(checkoutRoot);
  const refusedRoots: ReferenceSpecReport[] = [];
  for (const root of roots) {
    const refusal = await request.add(root);
    if (refusal) refusedRoots.push(notReadReport(root, refusal));
  }
  const sentRoots = roots.filter((root) => request.has(root));
  if (sentRoots.length === 0) return modelRoute("spec_rejected", refusedRoots);

  for (let round = 0; round <= SPEC_READER_LIMITS.maxNeedFilesRounds; round += 1) {
    const call = await callWithRetry(client, request.input(sentRoots));
    if (!call.ok) return modelRoute("reader_unavailable", [...refusedRoots, ...sentRoots.map(notRead("reader_failed"))]);

    const checked = checkSpecReaderOutput(call.output);
    if (!checked.ok) return modelRoute("spec_rejected", [...refusedRoots, ...sentRoots.map(notRead("invalid_output"))]);
    const output = checked.output;
    if (output.status === "read") return specRoute(output, request, refusedRoots);

    for (const path of output.needFiles) await request.add(path);
  }
  return modelRoute("spec_rejected", [...refusedRoots, ...sentRoots.map(notRead("too_many_rounds"))]);
}

async function callWithRetry(client: SpecReaderClient, input: SpecReaderInput): Promise<SpecReaderCallResult> {
  let result: SpecReaderCallResult = { ok: false, code: "not_called", message: "The job was not called." };
  for (let attempt = 0; attempt < CALL_ATTEMPTS && !result.ok; attempt += 1) {
    result = await client.read(input).catch((): SpecReaderCallResult => ({
      ok: false,
      code: "call_failed",
      message: "The job call failed.",
    }));
  }
  return result;
}

function specRoute(
  output: SpecReaderResult,
  request: SpecRequest,
  refusedRoots: readonly ReferenceSpecReport[],
): RepositorySpecRead {
  const parsed = output.specs
    .filter((spec): spec is ParsedSpec => spec.outcome === "parsed")
    .sort((left, right) => left.root.localeCompare(right.root));
  const specReports: ReferenceSpecReport[] = [
    ...refusedRoots,
    ...output.specs.map((spec) => outcomeReport(spec, output.fileIssues)),
  ];
  const fileIssues = fileIssueReports(output.fileIssues);
  if (parsed.length === 0) {
    return modelRoute("spec_rejected", specReports, { readerVersion: output.readerVersion, fileIssues });
  }

  const redactor = new SecretRedactor();
  const surface = buildSpecSurface({
    specs: parsed,
    readerVersion: output.readerVersion,
    contentHash: request.contentHash(parsed.flatMap((spec) => spec.files)),
    redactor,
  });
  const skippedOperationCount = parsed.reduce((total, spec) => total + spec.skippedOperations.length, 0);
  return {
    surface,
    report: {
      status: skippedOperationCount > 0 ? "openapi_partial" : "openapi",
      specs: specReports,
      ...nonEmpty("fileIssues", fileIssues),
      ...nonEmpty("skippedOperations", skippedOperationReports(parsed)),
      readerVersion: output.readerVersion,
      operationCount: surface.groups.reduce((total, group) => total + group.endpoints.length, 0),
      skippedOperationCount,
      redactedSecretCount: redactor.count,
    },
  };
}

function modelRoute(
  status: Exclude<ReferenceSourceStatus, "openapi" | "openapi_partial">,
  specs: ReferenceSpecReport[],
  read: { readerVersion?: string; fileIssues?: ReferenceFileIssue[] } = {},
): RepositorySpecRead {
  return {
    report: {
      status,
      specs,
      ...nonEmpty("fileIssues", read.fileIssues ?? []),
      ...(read.readerVersion ? { readerVersion: read.readerVersion } : {}),
      operationCount: 0,
      skippedOperationCount: 0,
      redactedSecretCount: 0,
    },
  };
}

function notRead(code: SpecNotReadCode): (path: string) => ReferenceSpecReport {
  return (path) => notReadReport(path, code);
}

/** A list field only when the list has items, so a clean report stays small. */
function nonEmpty<Key extends string, Item>(key: Key, items: Item[]): Partial<Record<Key, Item[]>> {
  const result: Partial<Record<Key, Item[]>> = {};
  if (items.length > 0) result[key] = items;
  return result;
}

/**
 * The files of the job requests of one run. Every file passes gate G1
 * before it joins. A file that G1 refuses, or that would pass the file or
 * byte limit, is sent as unavailable, so the job stops asking for it.
 */
class SpecRequest {
  private readonly files = new Map<string, string>();
  private readonly unavailable = new Set<string>();
  private encodedBytes = 0;

  constructor(private readonly checkoutRoot: string) {}

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** Adds a file through gate G1. Returns the refusal code, or undefined when the file joined. */
  async add(path: string): Promise<SpecRequestRefusal | undefined> {
    if (this.files.has(path) || this.unavailable.has(path)) return undefined;
    const refusal = await this.gate(path);
    if (refusal) this.unavailable.add(path);
    return refusal;
  }

  input(roots: readonly string[]): SpecReaderInput {
    return {
      roots: [...roots],
      files: Object.fromEntries(this.files),
      ...(this.unavailable.size > 0 ? { unavailable: [...this.unavailable].sort() } : {}),
    };
  }

  /** The hash of the text of the given files, for the source of the surface. */
  contentHash(paths: readonly string[]): string {
    const unique = [...new Set(paths)].sort();
    return hashObject(unique.map((path) => [path, this.files.get(path) ?? ""]));
  }

  private async gate(path: string): Promise<SpecRequestRefusal | undefined> {
    if (this.files.size >= SPEC_READER_LIMITS.maxFiles) return "too_many_files";
    const result = await readSpecFile(this.checkoutRoot, path);
    if (!result.ok) return result.refusal;
    const bytes = encodedSize(path) + encodedSize(result.text);
    if (this.encodedBytes + bytes > SPEC_READER_LIMITS.maxRequestBytes) return "request_too_large";
    this.encodedBytes += bytes;
    this.files.set(path, result.text);
    return undefined;
  }
}

/** The bytes of a string inside the JSON request, quotes and escapes included. */
function encodedSize(text: string): number {
  return Buffer.byteLength(JSON.stringify(text));
}
