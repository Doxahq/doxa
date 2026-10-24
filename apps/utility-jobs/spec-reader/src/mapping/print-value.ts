import { isSpecArray, isSpecObject, type SpecValue } from "../document/tree";

class PrintLimitError extends Error {}

/**
 * JSON of a spec value with keys in document order and bigints exact.
 * `pretty` indents with two spaces; otherwise the JSON is compact.
 * Undefined when the text would pass `maxChars`: the printer stops at the
 * limit instead of printing a huge value first.
 */
export function printJson(value: SpecValue, maxChars: number, pretty = true): string | undefined {
  const parts: string[] = [];
  let length = 0;
  const write = (text: string) => {
    length += text.length;
    if (length > maxChars) throw new PrintLimitError();
    parts.push(text);
  };
  const newline = (indent: string) => (pretty ? `\n${indent}` : "");

  const printList = (
    items: readonly (readonly [string | undefined, SpecValue])[],
    open: string,
    close: string,
    indent: string,
  ): void => {
    if (items.length === 0) return write(`${open}${close}`);
    const inner = `${indent}  `;
    write(open);
    items.forEach(([key, item], index) => {
      write(newline(inner));
      if (key !== undefined) write(`${JSON.stringify(key)}:${pretty ? " " : ""}`);
      print(item, inner);
      if (index < items.length - 1) write(",");
    });
    write(`${newline(indent)}${close}`);
  };

  const print = (current: SpecValue, indent: string): void => {
    if (isSpecArray(current)) {
      return printList(current.map((item) => [undefined, item] as const), "[", "]", indent);
    }
    if (isSpecObject(current)) return printList(Object.entries(current), "{", "}", indent);
    write(scalarJson(current));
  };

  try {
    print(value, "");
    return parts.join("");
  } catch (error) {
    if (error instanceof PrintLimitError) return undefined;
    throw error;
  }
}

/**
 * A short text form of a value, as a parameter or field example shows it:
 * a string as it is, any other value as compact JSON.
 */
export function printScalar(value: SpecValue, maxChars: number): string | undefined {
  if (typeof value === "string") return value.length <= maxChars ? value : undefined;
  return printJson(value, maxChars, false);
}

function scalarJson(value: string | number | bigint | boolean | null): string {
  return typeof value === "bigint" ? value.toString() : JSON.stringify(value);
}
