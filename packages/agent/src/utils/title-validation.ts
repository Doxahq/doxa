const PUNCTUATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
];

export function hasUnbalancedPunctuation(title: string): boolean {
  return PUNCTUATION_PAIRS.some(
    ([open, close]) => title.split(open).length !== title.split(close).length,
  );
}
