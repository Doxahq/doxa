import type { ReferenceSourceReport, ReferenceSpecReport } from "@doxahq/agent";

export const API_REFERENCE_SOURCE_EVENT_TYPE = "api_reference_source";

/** Spec paths that one log line names; the line counts the others. */
const MAX_NAMED_SPECS = 3;

export interface ReferenceSourceLogEvent {
  type: typeof API_REFERENCE_SOURCE_EVENT_TYPE;
  message: string;
  /** Flat fields, so that the generation log shows each one in full. */
  data: {
    status: ReferenceSourceReport["status"];
    specs: string;
    endpoints: number;
    skipped: number;
    fileIssues: number;
  };
}

/**
 * The log line that says where the REST reference of a run came from: the
 * spec files that were read, or why the code was used. The full report,
 * with every problem, stays in the `analysis_complete` event.
 */
export function referenceSourceLogEvent(report: ReferenceSourceReport): ReferenceSourceLogEvent {
  const parsed = report.specs.filter((spec) => spec.outcome === "parsed");
  const unused = report.specs.filter((spec) => spec.outcome !== "parsed");
  return {
    type: API_REFERENCE_SOURCE_EVENT_TYPE,
    message: referenceSourceMessage(report, parsed, unused),
    data: {
      status: report.status,
      specs: namedPaths(report.specs) || "none",
      endpoints: report.operationCount,
      skipped: report.skippedOperationCount,
      fileIssues: report.fileIssues?.length ?? 0,
    },
  };
}

function referenceSourceMessage(
  report: ReferenceSourceReport,
  parsed: readonly ReferenceSpecReport[],
  unused: readonly ReferenceSpecReport[],
): string {
  switch (report.status) {
    case "openapi":
    case "openapi_partial":
      return [
        `${specsRead(parsed)}: ${count(report.operationCount, "endpoint")}.`,
        report.skippedOperationCount > 0
          ? `${count(report.skippedOperationCount, "operation")} ${report.skippedOperationCount === 1 ? "was" : "were"} left out.`
          : "",
        unused.length > 0 ? `${count(unused.length, "other spec file")} could not be used.` : "",
        (report.fileIssues?.length ?? 0) > 0 ? `${count(report.fileIssues?.length ?? 0, "file")} did not parse.` : "",
      ].filter(Boolean).join(" ");
    case "no_spec":
      return "No OpenAPI spec found. The REST reference comes from the code.";
    case "spec_rejected":
      return `${specsNamed(unused)} could not be used. The REST reference comes from the code.`;
    case "reader_unavailable":
      return `The OpenAPI spec reader did not run for ${namedPaths(report.specs) || "the spec files"}. The REST reference comes from the code.`;
  }
}

function specsRead(parsed: readonly ReferenceSpecReport[]): string {
  const [only] = parsed;
  if (parsed.length === 1 && only?.specVersion) return `Read the OpenAPI spec ${only.path} (${versionLabel(only.specVersion)})`;
  return `Read ${specsNamed(parsed).replace(/^The /, "the ")}`;
}

/** "The OpenAPI spec a.yaml", or "2 OpenAPI specs (a.yaml, b.yaml)". */
function specsNamed(specs: readonly ReferenceSpecReport[]): string {
  const [only] = specs;
  if (specs.length === 1 && only) return `The OpenAPI spec ${only.path}`;
  return `${count(specs.length, "OpenAPI spec")} (${namedPaths(specs)})`;
}

function versionLabel(version: string): string {
  return version.startsWith("2.") ? `Swagger ${version}` : `OpenAPI ${version}`;
}

function namedPaths(specs: readonly ReferenceSpecReport[]): string {
  const names = specs.slice(0, MAX_NAMED_SPECS).map((spec) => spec.path);
  const more = specs.length - names.length;
  return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;
}
