interface ContentStatusInput {
  isSaving: boolean
  isDirty: boolean
  hasChanges: boolean
}

/** The short state in the content editor toolbar. */
export function describeWorkingStatus({
  isSaving,
  isDirty,
  hasChanges,
}: ContentStatusInput): string {
  if (isSaving) return "Saving…"
  if (isDirty) return "Unsaved"
  return hasChanges ? "Unpublished changes" : "Published"
}
