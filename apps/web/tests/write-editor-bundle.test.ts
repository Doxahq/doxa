import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const SRC = fileURLToPath(new URL("../src", import.meta.url))
const WRITE_EDITOR = join(SRC, "components/dashboard/content/write-editor/write-editor.tsx")

/**
 * A value import or re-export: `import x from "m"`, `import { a, type B } from "m"`,
 * `import "m"`, `export { a } from "m"`. Type-only imports and `import("m")` are skipped:
 * they add nothing to the chunk that loads with the module.
 */
const STATIC_IMPORT = /^(?:import|export)\s+(?!type\b)(?:[^"'`]*?\sfrom\s+)?["']([^"']+)["']/gm

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("~/") ? join(SRC, specifier.slice(2)) : resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate
  }
  return null
}

/** Every module and package that loads together with `entry`, following static imports only. */
function staticGraph(entry: string): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>()
  const packages = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (modules.has(file)) continue
    modules.add(file)
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      if (specifier.startsWith("~/") || specifier.startsWith(".")) {
        const local = resolveLocal(file, specifier)
        if (local) queue.push(local)
      } else {
        packages.add(specifier)
      }
    }
  }
  return { modules, packages }
}

describe("the Write editor's first load", () => {
  const graph = staticGraph(WRITE_EDITOR)
  const modules = [...graph.modules].map((file) => relative(SRC, file))
  const packages = [...graph.packages]

  test("follows the editor's imports", () => {
    // The walk must reach the node views and the lazy code editor, or it proves nothing.
    expect(modules).toContain("components/dashboard/content/write-editor/node-views.tsx")
    expect(modules).toContain("components/code-editor/lazy-code-editor.tsx")
    expect(packages).toContain("@tiptap/react")
  })

  test("does not load CodeMirror until a code editor opens", () => {
    expect(packages.filter((name) => name.startsWith("@codemirror/") || name.startsWith("@lezer/"))).toEqual([])
    expect(modules.filter((file) => file.startsWith("components/code-editor/"))).toEqual([
      "components/code-editor/lazy-code-editor.tsx",
    ])
  })

  test("does not load Shiki or its grammars until the highlighter is needed", () => {
    expect(packages.filter((name) => /^(shiki|@shikijs\/)/.test(name))).toEqual([])
    expect(packages.filter((name) => name.startsWith("@doxahq/mdx-runtime/highlight"))).toEqual([])
  })
})
