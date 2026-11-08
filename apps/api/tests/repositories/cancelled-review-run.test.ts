import { describe, expect, test } from "vitest";
import {
  cancelledCheckFromEventData,
  withCancelledCheck,
} from "../../src/repositories/cancelled-review-run";

const stopped = {
  title: "Documentation preview stopped",
  summary: "The pull request was merged, so Doxa stopped this preview.",
};

describe("the check text of a cancel event", () => {
  test("goes into the event data next to the caller's data, and reads back", () => {
    const data = withCancelledCheck({ reason: "merged" }, stopped);

    expect(data).toEqual({ reason: "merged", check: stopped });
    expect(cancelledCheckFromEventData({ ...data, outcome: "cancelled", terminal: true })).toEqual(stopped);
  });

  test("leaves the data as it is when the cancel has no check text", () => {
    expect(withCancelledCheck({ requestedByUserId: "user-1" }, undefined)).toEqual({ requestedByUserId: "user-1" });
    expect(withCancelledCheck(undefined, undefined)).toBeUndefined();
  });

  test.each([
    ["no data", null],
    ["no check", { outcome: "cancelled" }],
    ["an empty title", { check: { title: " ", summary: "text" } }],
    ["a check that is not an object", { check: "stopped" }],
  ])("reads nothing from %s", (_name, data) => {
    expect(cancelledCheckFromEventData(data)).toBeNull();
  });
});
