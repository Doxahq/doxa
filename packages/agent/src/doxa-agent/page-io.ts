import type { DocPage, GeneratedPageContent } from "../types";
import { fileExists, readTextFile, sha256String } from "../utils/runtime";
import {
  ProjectPathAccessError,
  resolveProjectPath,
} from "../core/tools/project-path";
import { emptyPageDependencyState } from "../state/page-targets";

export async function readExistingPages(
  outputDir: string,
  pages: Array<{ sectionTitle: string; page: DocPage; path: string }>
): Promise<GeneratedPageContent[]> {
  const result: GeneratedPageContent[] = [];

  for (const { page, path } of pages) {
    try {
      const fullPath = await resolveProjectPath(outputDir, path);
      if (await fileExists(fullPath)) {
        const content = await readTextFile(fullPath);
        const id = page.id;
        const title = page.title;
        result.push({
          id,
          path: fullPath,
          title,
          content,
          dependencies: emptyPageDependencyState(),
          contentHash: hashString(content),
          pageInputHash: hashString(
            JSON.stringify({ id, path, title }),
          ),
        });
      }
    } catch (error) {
      if (error instanceof ProjectPathAccessError) throw error;
      // Skip files that can't be read
    }
  }

  return result;
}

/**
 * Compute a SHA-256 hash of a string.
 */
export function hashString(str: string): string {
  return sha256String(str);
}
