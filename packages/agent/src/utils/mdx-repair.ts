import { createHash } from "node:crypto";

const MAX_PATCH_SPAN = 512;
const MAX_REPLACEMENT_CHARS = 2_048;

export interface LocatedMdxIssue {
  rule: string;
  message: string;
  line?: number;
  column?: number;
}

export interface MdxRepairPatch {
  draftSha256: string;
  startOffset: number;
  endOffset: number;
  replacement: string;
  explanation: string;
}

export interface MdxRepairPatchValidation {
  ok: boolean;
  reason?: string;
}

export function lineColumnToOffset(
  source: string,
  line: number,
  column: number,
): number | null {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) {
    return null;
  }
  const lines = source.split("\n");
  const target = lines[line - 1];
  if (target === undefined) return null;
  const codePoints = Array.from(target);
  if (column - 1 > codePoints.length) return null;

  let offset = 0;
  for (let index = 0; index < line - 1; index++) {
    offset += lines[index]!.length + 1;
  }
  return offset + codePoints.slice(0, column - 1).join("").length;
}

export function validateMdxRepairPatch(input: {
  draft: string;
  parserOffset: number;
  patch: MdxRepairPatch;
}): MdxRepairPatchValidation {
  const { draft, parserOffset, patch } = input;
  if (patch.draftSha256 !== sha256(draft)) {
    return { ok: false, reason: "stale-draft-hash" };
  }
  if (
    !Number.isInteger(patch.startOffset) ||
    !Number.isInteger(patch.endOffset) ||
    patch.startOffset < 0 ||
    patch.endOffset < patch.startOffset ||
    patch.endOffset > draft.length
  ) {
    return { ok: false, reason: "invalid-offsets" };
  }
  if (patch.endOffset - patch.startOffset > MAX_PATCH_SPAN) {
    return { ok: false, reason: "patch-span-too-large" };
  }
  if (patch.replacement.length > MAX_REPLACEMENT_CHARS) {
    return { ok: false, reason: "replacement-too-large" };
  }
  if (parserOffset < patch.startOffset || parserOffset > patch.endOffset) {
    return { ok: false, reason: "patch-does-not-overlap-parser-location" };
  }
  return { ok: true };
}

export function applyMdxRepairPatch(
  draft: string,
  patch: MdxRepairPatch,
): string {
  return (
    draft.slice(0, patch.startOffset) +
    patch.replacement +
    draft.slice(patch.endOffset)
  );
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
