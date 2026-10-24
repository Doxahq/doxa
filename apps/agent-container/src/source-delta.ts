import type {
  GenerationSourceState,
  RepositorySnapshot,
  SourceChange,
  SourceFileHash,
} from "@doxahq/contracts";
import { normalizeSourceChanges } from "@doxahq/generation";

export function resolveSnapshotSourceDelta(input: {
  snapshot: RepositorySnapshot;
  current: GenerationSourceState;
  previous?: GenerationSourceState;
}): RepositorySnapshot {
  if (
    input.current.sourceRevision !== input.snapshot.targetRevision ||
    input.current.sourceTreeHash !== input.snapshot.sourceTreeHash
  ) {
    throw new Error(
      "Current source state does not match the prepared repository snapshot.",
    );
  }
  if (!input.previous) {
    return input.snapshot;
  }
  if (
    input.previous.sourceTreeHash === input.current.sourceTreeHash
  ) {
    return {
      ...input.snapshot,
      changes: [],
    };
  }
  return {
    ...input.snapshot,
    changes: sourceStateChanges(
      input.previous.files,
      input.current.files,
    ),
  };
}

function sourceStateChanges(
  previousFiles: readonly SourceFileHash[],
  currentFiles: readonly SourceFileHash[],
): SourceChange[] {
  const previousByPath = new Map(
    previousFiles.map((file) => [file.path, file]),
  );
  const currentByPath = new Map(
    currentFiles.map((file) => [file.path, file]),
  );
  const changes: SourceChange[] = [];
  const removed: SourceFileHash[] = [];
  const added: SourceFileHash[] = [];

  for (const previous of previousFiles) {
    const current = currentByPath.get(previous.path);
    if (!current) {
      removed.push(previous);
      continue;
    }
    if (
      current.contentHash !== previous.contentHash ||
      current.contentKind !== previous.contentKind
    ) {
      changes.push({
        path: current.path,
        status: "modified",
      });
    }
  }
  for (const current of currentFiles) {
    if (!previousByPath.has(current.path)) {
      added.push(current);
    }
  }

  const removedByIdentity = filesByIdentity(removed);
  const addedByIdentity = filesByIdentity(added);
  const renamedRemoved = new Set<string>();
  const renamedAdded = new Set<string>();
  for (const [identity, previousMatches] of removedByIdentity) {
    const currentMatches = addedByIdentity.get(identity);
    if (
      previousMatches.length !== 1 ||
      currentMatches?.length !== 1
    ) {
      continue;
    }
    const [previous] = previousMatches;
    const [current] = currentMatches;
    changes.push({
      path: current.path,
      previousPath: previous.path,
      status: "renamed",
    });
    renamedRemoved.add(previous.path);
    renamedAdded.add(current.path);
  }
  for (const previous of removed) {
    if (!renamedRemoved.has(previous.path)) {
      changes.push({
        path: previous.path,
        status: "deleted",
      });
    }
  }
  for (const current of added) {
    if (!renamedAdded.has(current.path)) {
      changes.push({
        path: current.path,
        status: "added",
      });
    }
  }
  return normalizeSourceChanges(changes);
}

function filesByIdentity(
  files: readonly SourceFileHash[],
): Map<string, SourceFileHash[]> {
  const byIdentity = new Map<string, SourceFileHash[]>();
  for (const file of files) {
    const identity = `${file.contentKind}:${file.contentHash}`;
    const matches = byIdentity.get(identity) ?? [];
    matches.push(file);
    byIdentity.set(identity, matches);
  }
  return byIdentity;
}
