/** What Enter does for each row of the dialog, in the order the rows appear. */
export function createSearchActivations(input: {
  hasQuery: boolean;
  resultActions: readonly (() => void)[];
  recentActions: readonly (() => void)[];
  /** Null when the site has no chat, so the list has no "Ask AI" row. */
  askAi: (() => void) | null;
}): (() => void)[] {
  if (!input.hasQuery) return [...input.recentActions];
  return input.askAi
    ? [...input.resultActions, input.askAi]
    : [...input.resultActions];
}
