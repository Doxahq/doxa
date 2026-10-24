import type { ReferenceFileIssue, ReferenceSourceReport } from "@doxahq/contracts"

/** One spec problem, as the generation page lists it. */
export interface SpecProblem {
  /** The spec file, or the referenced file, that has the problem. */
  path: string
  /** "Line 537, column 9", when the parser knew it. */
  location: string | null
  /** The operation that was left out, such as "GET /orders". */
  operation: string | null
  message: string
}

/** The spec problems of a run: what happened, and what to fix. */
export interface SpecProblemNotice {
  heading: string
  summary: string
  problems: SpecProblem[]
  /** Skipped operations that the report counted but did not list. */
  unlistedOperationCount: number
}

/** An older API sends no report; that reads as none. */
export function readReferenceSource(source: { referenceSource?: ReferenceSourceReport | null }): ReferenceSourceReport | null {
  return source.referenceSource ?? null
}

/**
 * The notice for the spec problems of a run, or null when the REST
 * reference has nothing to fix: no spec file, or a spec read cleanly.
 */
export function specProblemNotice(report: ReferenceSourceReport | null): SpecProblemNotice | null {
  if (!report) return null
  const problems = [...specFileProblems(report), ...skippedOperationProblems(report)]
  const unlistedOperationCount = report.skippedOperationCount - (report.skippedOperations?.length ?? 0)
  if (problems.length === 0 && unlistedOperationCount <= 0) return null

  return {
    ...noticeText(report),
    problems,
    unlistedOperationCount: Math.max(0, unlistedOperationCount),
  }
}

function noticeText(report: ReferenceSourceReport): Pick<SpecProblemNotice, "heading" | "summary"> {
  switch (report.status) {
    case "spec_rejected":
      return {
        heading: "The API spec could not be used",
        summary: "The REST reference was built from the code instead. Fix the problems below, then run the generation again to build it from the spec.",
      }
    case "reader_unavailable":
      return {
        heading: "The API spec was not read",
        summary: "The REST reference was built from the code instead. Run the generation again to read the spec.",
      }
    case "openapi_partial":
      return {
        heading: operationsLeftOutHeading(report.skippedOperationCount),
        summary: "These operations failed the checks and have no page. Fix them in the spec, then run the generation again.",
      }
    case "openapi":
    case "no_spec":
      return {
        heading: "Some spec files could not be read",
        summary: "The API reference was built from the spec, but the parts that these files define are missing. Fix them, then run the generation again.",
      }
  }
}

function operationsLeftOutHeading(count: number): string {
  return count === 1 ? "1 API operation was left out" : `${count} API operations were left out`
}

/**
 * Every spec file that was not used, then every other file that did not
 * parse. A file that did not parse shows its line and column.
 */
function specFileProblems(report: ReferenceSourceReport): SpecProblem[] {
  const issuesByFile = new Map((report.fileIssues ?? []).map((issue) => [issue.file, issue]))
  const fromSpecs = report.specs
    .filter((spec) => spec.outcome !== "parsed")
    .map((spec): SpecProblem => {
      const issue = issuesByFile.get(spec.path)
      return {
        path: spec.path,
        location: issue ? issueLocation(issue) : null,
        operation: null,
        message: issue?.message ?? spec.message ?? "The file could not be used.",
      }
    })
  const reported = new Set(fromSpecs.map((problem) => problem.path))
  const fromIssues = (report.fileIssues ?? [])
    .filter((issue) => !reported.has(issue.file))
    .map((issue): SpecProblem => ({
      path: issue.file,
      location: issueLocation(issue),
      operation: null,
      message: issue.message,
    }))
  return [...fromSpecs, ...fromIssues]
}

function skippedOperationProblems(report: ReferenceSourceReport): SpecProblem[] {
  return (report.skippedOperations ?? []).map((operation) => ({
    path: operation.specPath,
    location: null,
    operation: `${operation.method} ${operation.path}`,
    message: operation.message,
  }))
}

function issueLocation(issue: ReferenceFileIssue): string | null {
  if (issue.line === undefined) return null
  return issue.column === undefined ? `Line ${issue.line}` : `Line ${issue.line}, column ${issue.column}`
}
