/** Alt text inside `![...]`: one line, no brackets. */
export function imageMarkdown(path: string, altText: string | undefined): string {
  const alt = (altText ?? "")
    .replace(/[[\]\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `![${alt}](${path})`;
}

export const ALT_TEXT_DESCRIPTION = "Alt text for the returned markdown line.";
