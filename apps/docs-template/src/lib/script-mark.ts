import { DOCS_SCRIPT_MARK_ATTRIBUTE } from "@doxahq/contracts/docs-script-mark";

/**
 * A new mark for one server render, see `DOCS_SCRIPT_MARK_ATTRIBUTE`. The
 * browser gets no mark, because the gateway removes it from the HTML.
 */
export function createScriptMark(): string | undefined {
  return typeof document === "undefined" ? crypto.randomUUID() : undefined;
}

/** The attribute of the `<html>` tag that names the mark of this render. */
export function scriptMarkAttributes(
  mark: string | undefined
): Record<string, string> {
  return mark ? { [DOCS_SCRIPT_MARK_ATTRIBUTE]: mark } : {};
}
