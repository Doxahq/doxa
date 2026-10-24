import { isKnownSpecFileName } from "../reference-specs/spec-paths";
import type {
  RevisionSourceChange,
  SourceChangeSet,
} from "./types";

export const EMPTY_SOURCE_CHANGES: SourceChangeSet = {
  changedFiles: [],
  addedFiles: [],
  deletedFiles: [],
};

export function hasSourceChanges(sourceChanges: SourceChangeSet | null | undefined): boolean {
  return sourceChangeCount(sourceChanges) > 0;
}

export function sourceChangeCount(sourceChanges: SourceChangeSet | null | undefined): number {
  if (!sourceChanges) return 0;
  return (
    sourceChanges.changedFiles.length +
    sourceChanges.addedFiles.length +
    sourceChanges.deletedFiles.length
  );
}

export function mergeSourceChanges(...changes: SourceChangeSet[]): SourceChangeSet {
  return {
    changedFiles: unique(changes.flatMap((change) => change.changedFiles)),
    addedFiles: unique(changes.flatMap((change) => change.addedFiles)),
    deletedFiles: unique(changes.flatMap((change) => change.deletedFiles)),
  };
}

export function filterSourceChanges(
  sourceChanges: SourceChangeSet,
  predicate: (path: string) => boolean,
): SourceChangeSet {
  return {
    changedFiles: sourceChanges.changedFiles.filter(predicate),
    addedFiles: sourceChanges.addedFiles.filter(predicate),
    deletedFiles: sourceChanges.deletedFiles.filter(predicate),
  };
}

export function sourceChangePaths(
  changes: readonly RevisionSourceChange[],
): string[] {
  return unique(
    changes.flatMap((change) => [
      change.path,
      ...(change.previousPath ? [change.previousPath] : []),
    ]),
  );
}

export function isDocumentationRelevantSourcePath(path: string): boolean {
  const normalized = path.toLowerCase();
  const fileName = normalized.split("/").at(-1) ?? normalized;
  if (
    normalized.startsWith(".github/") ||
    normalized.startsWith(".changeset/") ||
    normalized.includes("/__snapshots__/") ||
    normalized.includes("/fixtures/") ||
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    /\.(?:test|spec|snap)\.[^.]+$/.test(normalized) ||
    /^(?:changelog|license|codeowners)(?:\.|$)/.test(fileName) ||
    /^(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock)$/.test(
      fileName,
    ) ||
    /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|mp4|mov|woff2?)$/.test(
      normalized,
    ) ||
    /^(?:eslint|prettier|biome|commitlint)\./.test(fileName)
  ) {
    return false;
  }
  return true;
}

export function isStructuralSourcePath(path: string): boolean {
  const normalized = path.toLowerCase();
  return (
    isPackageManifestPath(normalized) ||
    /(?:^|\/)(?:routes?|api|schemas?|openapi|swagger|graphql)(?:\/|\.|-)/.test(
      normalized,
    ) ||
    /\.(?:graphql|gql|proto)$/.test(normalized) ||
    isKnownSpecFileName(normalized) ||
    isDocsConfigPath(normalized)
  );
}

/** A package manifest. Adding or removing one adds or removes a package. */
export function isPackageManifestPath(path: string): boolean {
  const fileName = path.toLowerCase().split("/").at(-1) ?? "";
  return /^(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|composer\.json)$/.test(fileName);
}

/** The configuration of a documentation tool, which can describe the site's sections. */
export function isDocsConfigPath(path: string): boolean {
  return /(?:^|\/)(?:docs?|mint|nextra|docusaurus|vitepress)\.config\./.test(path.toLowerCase());
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
