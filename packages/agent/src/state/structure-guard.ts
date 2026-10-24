import type { DocumentationStructure } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a stored value that has the shape of a flat documentation structure. */
export function isDocumentationStructure(
  value: unknown,
): value is DocumentationStructure {
  if (!isRecord(value) || !Array.isArray(value.sections)) {
    return false;
  }
  return value.sections.every((section) => {
    if (
      !isRecord(section) ||
      typeof section.id !== "string" ||
      typeof section.title !== "string" ||
      !Array.isArray(section.pages)
    ) {
      return false;
    }
    return section.pages.every((page) => {
      if (
        !isRecord(page) ||
        typeof page.id !== "string" ||
        typeof page.title !== "string" ||
        typeof page.description !== "string" ||
        (page.subPages !== undefined &&
          (!Array.isArray(page.subPages) || page.subPages.length > 0))
      ) {
        return false;
      }
      return true;
    });
  });
}
