import type { SpecFileIssue } from "@doxahq/contracts/spec-reader";
import { parseSpecDocument } from "./parse";
import type { DocumentIssue } from "./parse-issues";
import type { SpecValue } from "./tree";

export type SpecFileLookup =
  | { status: "found"; value: SpecValue }
  /** The request did not carry the file; the agent container can send it next round. */
  | { status: "missing" }
  /** The agent container refused the file at gate G1. */
  | { status: "unavailable" }
  | { status: "invalid"; issue: DocumentIssue };

/**
 * The files of one job call. Each file is parsed on first use, at most once.
 * A lookup of a file that the request did not carry records it in `missing`.
 */
export class SpecFiles {
  readonly missing = new Set<string>();
  private readonly parsed = new Map<string, SpecFileLookup>();

  constructor(
    private readonly texts: ReadonlyMap<string, string>,
    private readonly unavailable: ReadonlySet<string>,
  ) {}

  /** The files that failed to parse so far, by path. */
  issues(): SpecFileIssue[] {
    return [...this.parsed]
      .flatMap(([file, lookup]) => (lookup.status === "invalid" ? [{ file, ...lookup.issue }] : []))
      .sort((left, right) => left.file.localeCompare(right.file));
  }

  lookup(path: string): SpecFileLookup {
    const cached = this.parsed.get(path);
    if (cached) return cached;

    const lookup = this.parse(path);
    if (lookup.status === "missing") this.missing.add(path);
    this.parsed.set(path, lookup);
    return lookup;
  }

  /**
   * Replaces the parsed value of a file. A root that was upgraded to the 3.1
   * shape uses this, so its own local references read the upgraded tree.
   */
  setDocument(path: string, value: SpecValue): void {
    this.parsed.set(path, { status: "found", value });
  }

  private parse(path: string): SpecFileLookup {
    if (this.unavailable.has(path)) return { status: "unavailable" };
    const text = this.texts.get(path);
    if (text === undefined) return { status: "missing" };

    const result = parseSpecDocument(path, text);
    return result.ok
      ? { status: "found", value: result.value }
      : { status: "invalid", issue: result.issue };
  }
}
