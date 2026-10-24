import type { DocPage, DocumentationStructure } from "../types";
import { DEFAULT_SECTION_FOLDER, pageOutputPath, sectionFolder, slugify } from "./route-registry";

export { DEFAULT_SECTION_FOLDER, sectionFolder, slugify };

export interface FlattenedStructurePage {
  sectionId: string;
  sectionTitle: string;
  page: DocPage;
  path: string;
}

export function flattenStructure(
  structure: DocumentationStructure,
): FlattenedStructurePage[] {
  const pages: FlattenedStructurePage[] = [];

  for (const section of structure.sections) {
    for (const page of section.pages) {
      pages.push({
        sectionId: section.id,
        sectionTitle: section.title,
        page,
        path: pageOutputPath(section, page),
      });

    }
  }

  return pages;
}

export function stablePageId(target: FlattenedStructurePage): string {
  return `${target.sectionId}/${target.page.id}`;
}

export function validateGlobalPageIds(
  structure: DocumentationStructure,
): string[] {
  const ownerByPageId = new Map<string, string>();
  const errors: string[] = [];

  for (const target of flattenStructure(structure)) {
    const pageId = stablePageId(target);
    const existingOwner = ownerByPageId.get(pageId);
    if (existingOwner) {
      errors.push(
        `Duplicate stable page ID "${pageId}" is used by ${existingOwner} and ${target.path}. ` +
          "Every page ID must be globally unique.",
      );
      continue;
    }
    ownerByPageId.set(pageId, target.path);
  }

  return errors;
}
