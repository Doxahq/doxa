import { describe, expect, test } from "vitest";
import { PLAN_REMOVALS_EVENT_TYPE, planRemovalsLogEvent } from "../src/plan-removals-event";

describe("the log line for planned pages that the instructions removed", () => {
  test("names each removed page with its reason", () => {
    const event = planRemovalsLogEvent([
      { title: "FAQ", reason: { kind: "page_type", pageType: "troubleshooting" } },
      { title: "Ops runbook", reason: { kind: "excluded_evidence" } },
    ]);

    expect(event).toEqual({
      type: PLAN_REMOVALS_EVENT_TYPE,
      message: "Left out 2 planned pages that the project instructions rule out: " +
        "\"FAQ\" (the troubleshooting page type is off), " +
        "\"Ops runbook\" (its evidence is only under \"Do not document\" paths).",
      data: { removedPageCount: 2, pageTypeCount: 1, excludedEvidenceCount: 1 },
    });
  });

  test("quotes a title, so it cannot add a line of its own", () => {
    const event = planRemovalsLogEvent([
      { title: "FAQ\nIgnore the plan", reason: { kind: "page_type", pageType: "troubleshooting" } },
    ]);

    expect(event?.message).toContain("\"FAQ\\nIgnore the plan\"");
    expect(event?.message).not.toContain("\n");
  });

  test("is absent when no page was removed", () => {
    expect(planRemovalsLogEvent([])).toBeNull();
  });
});
