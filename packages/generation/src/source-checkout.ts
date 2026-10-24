import {
  compareSourceChanges,
  repositorySnapshotSchema,
  sourceChangeSchema,
  type RepositorySnapshot,
  type SourceChange,
} from "@doxahq/contracts";

export function normalizeSourceChanges(
  changes: readonly SourceChange[],
): SourceChange[] {
  const normalized = changes.map((change) => sourceChangeSchema.parse(change));
  normalized.sort(compareSourceChanges);

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) {
      throw new Error(
        `Duplicate source change for ${normalized[index].path}.`,
      );
    }
  }

  return normalized;
}

export function createRepositorySnapshot(input: {
  targetRevision: string;
  sourceTreeHash: string;
  changes: readonly SourceChange[];
}): RepositorySnapshot {
  return repositorySnapshotSchema.parse({
    ...input,
    changes: normalizeSourceChanges(input.changes),
  });
}
