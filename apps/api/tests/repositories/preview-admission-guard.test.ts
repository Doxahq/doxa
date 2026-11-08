import { describe, expect, test } from "vitest";
import {
  previewAdmissionStop,
  type PreviewAdmissionGuard,
  type PreviewGateRecord,
} from "../../src/repositories/preview-admission-guard";

const head = "b".repeat(40);
const seen: PreviewGateRecord = {
  state: "open",
  baseRef: "main",
  headRevision: head,
  sourceUpdatedAt: new Date("2026-11-08T10:00:00.000Z"),
};
const guard: PreviewAdmissionGuard = { seen, productionBranch: "main" };
const later = new Date("2026-11-08T10:00:05.000Z");

describe("the preview admission guard", () => {
  test("admits a record that is as the caller saw it", () => {
    expect(previewAdmissionStop({ ...seen }, guard, head)).toBeNull();
  });

  test("admits a record that the live pull request overruled", () => {
    // A re-run read GitHub: open, although the record still said closed.
    const behind = { ...seen, state: "closed" as const };
    expect(previewAdmissionStop(behind, { ...guard, seen: behind }, head)).toBeNull();
  });

  test.each([
    { change: "closed", record: { state: "closed" as const }, stop: "closed" },
    { change: "merged", record: { state: "merged" as const }, stop: "merged" },
    { change: "retargeted", record: { baseRef: "release" }, stop: "retargeted" },
    { change: "pushed", record: { headRevision: "c".repeat(40) }, stop: "superseded" },
  ])("refuses a record that was $change after the caller saw it", ({ record, stop }) => {
    expect(previewAdmissionStop({ ...seen, ...record, sourceUpdatedAt: later }, guard, head)).toBe(stop);
  });

  test("refuses a close in the same second as the push it races", () => {
    // GitHub times have whole seconds, so a close can carry the push's time.
    expect(previewAdmissionStop({ ...seen, state: "closed" }, guard, head)).toBe("closed");
  });

  test("admits a newer record that still allows the preview", () => {
    // A draft change, for example, writes the record but does not stop previews.
    expect(previewAdmissionStop({ ...seen, sourceUpdatedAt: later }, guard, head)).toBeNull();
  });

  test("a closed pull request that a later close keeps closed still refuses", () => {
    const behind = { ...seen, state: "closed" as const };
    expect(
      previewAdmissionStop({ ...behind, sourceUpdatedAt: later }, { ...guard, seen: behind }, head),
    ).toBe("closed");
  });
});
