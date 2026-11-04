import { existsSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { workspaceSourceAliases } from "./workspace-aliases";

function resolveAlias(specifier: string): string | undefined {
  for (const alias of workspaceSourceAliases) {
    if (alias.find instanceof RegExp && alias.find.test(specifier)) {
      return alias.replacement;
    }
  }
  return undefined;
}

describe("workspaceSourceAliases", () => {
  test.each([
    ["@doxahq/mdx-runtime", "/packages/mdx-runtime/src/index.ts"],
    [
      "@doxahq/mdx-runtime/highlight",
      "/packages/mdx-runtime/src/highlight/index.ts",
    ],
    [
      "@doxahq/mdx-runtime/highlight-lazy",
      "/packages/mdx-runtime/src/highlight/lazy.ts",
    ],
  ])("points %s at the package source", (specifier, suffix) => {
    const replacement = resolveAlias(specifier);
    expect(replacement?.endsWith(suffix)).toBe(true);
    expect(replacement && existsSync(replacement)).toBe(true);
  });

  test("matches whole specifiers only", () => {
    expect(resolveAlias("@doxahq/mdx-runtime/format")).toBeUndefined();
    expect(resolveAlias("@doxahq/mdx-runtime-extra")).toBeUndefined();
  });
});
