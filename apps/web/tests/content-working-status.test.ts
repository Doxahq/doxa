import { describe, expect, test } from "vitest"

import { describeWorkingStatus } from "~/lib/dashboard/content-working-status"

const base = { isSaving: false, isDirty: false, hasChanges: false }

describe("describeWorkingStatus", () => {
  test.each([
    [{}, "Published"],
    [{ hasChanges: true }, "Unpublished changes"],
    [{ isDirty: true, hasChanges: true }, "Unsaved"],
    [{ isSaving: true, isDirty: true }, "Saving…"],
  ])("%j → %s", (input, expected) => {
    expect(describeWorkingStatus({ ...base, ...input })).toBe(expected)
  })
})
