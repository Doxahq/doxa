import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

describe("agent worker import boundary", () => {
  test("keeps Node-only agent values out of the Worker bundle", async () => {
    const violations: string[] = [];

    for (const path of await typescriptFiles(sourceRoot)) {
      const source = await readFile(path, "utf8");
      const sourceFile = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      for (const statement of sourceFile.statements) {
        if (
          ts.isImportDeclaration(statement)
          && ts.isStringLiteral(statement.moduleSpecifier)
          && statement.moduleSpecifier.text === "@doxahq/agent"
          && statement.importClause?.isTypeOnly !== true
        ) {
          violations.push(path.slice(sourceRoot.length + 1));
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat().sort();
}
