/** An open fenced code block: its marker character and run length. */
export interface FenceState {
  readonly marker: "`" | "~";
  readonly length: number;
}

/**
 * The fence state after a line: opens a fence, closes the open one with a
 * marker run of the same character and at least the same length, or keeps
 * the current state.
 */
export function nextFenceState(
  line: string,
  current: FenceState | undefined,
): FenceState | undefined {
  const match = /^\s*(`{3,}|~{3,})/.exec(line);
  if (!match?.[1]) return current;

  const marker = match[1][0];
  if (marker !== "`" && marker !== "~") return current;

  if (!current) {
    return { marker, length: match[1].length };
  }
  if (current.marker === marker && match[1].length >= current.length) {
    return undefined;
  }
  return current;
}
