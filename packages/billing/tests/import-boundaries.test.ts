import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Spec 6.2: the import rules, each checked by a test. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".wrangler", ".turbo", ".output", ".tanstack", ".vinxi", "coverage", ".git", ".react-email-export"]);
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (SOURCE_FILE.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? "");
}

const repoFiles = [...walk(join(REPO_ROOT, "apps")), ...walk(join(REPO_ROOT, "packages")), ...walk(join(REPO_ROOT, "scripts"))].filter(
  (file) => !file.startsWith(PACKAGE_ROOT),
);
const rel = (file: string) => relative(REPO_ROOT, file).split(sep).join("/");

describe("import boundaries (spec 6.2)", () => {
  it("finds the repo source files", () => {
    expect(repoFiles.length).toBeGreaterThan(100);
  });

  it("never imports `stripe` outside packages/billing", () => {
    const offenders = repoFiles.filter((file) => importsOf(file).some((spec) => spec === "stripe" || spec.startsWith("stripe/")));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("lets apps/web import only @doxahq/billing/catalog", () => {
    const offenders = repoFiles
      .filter((file) => rel(file).startsWith("apps/web/"))
      .flatMap((file) => importsOf(file).filter((spec) => spec.startsWith("@doxahq/billing") && spec !== "@doxahq/billing/catalog").map((spec) => `${rel(file)}: ${spec}`));
    expect(offenders).toEqual([]);
  });

  it("keeps /payments and /stripe on the API Node origin (never in apps/mcp or a Worker build)", () => {
    const offenders = repoFiles
      .filter((file) => !rel(file).startsWith("apps/api/src/runtime/node/"))
      .flatMap((file) =>
        importsOf(file)
          .filter((spec) => spec.startsWith("@doxahq/billing/payments") || spec.startsWith("@doxahq/billing/stripe"))
          .map((spec) => `${rel(file)}: ${spec}`),
      );
    expect(offenders).toEqual([]);
  });

  it("keeps @doxahq/billing/testing out of app and package source (tests only)", () => {
    const offenders = repoFiles
      .filter((file) => !/(^|\/)(tests?|__tests__)\//.test(rel(file)) && !/\.(test|spec|integration\.test)\.[cm]?[tj]sx?$/.test(file))
      .flatMap((file) => importsOf(file).filter((spec) => spec === "@doxahq/billing/testing").map((spec) => `${rel(file)}: ${spec}`));
    expect(offenders).toEqual([]);
  });
});

describe("package boundaries", () => {
  const srcFiles = walk(join(PACKAGE_ROOT, "src"));

  /** Every file that an entry point reaches through relative imports. */
  function reach(entry: string): Set<string> {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of importsOf(file)) {
        if (!spec.startsWith(".")) continue;
        const base = resolve(dirname(file), spec);
        const target = [`${base}.ts`, join(base, "index.ts"), base].find((candidate) => {
          try {
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        });
        if (target) visit(target);
      }
    };
    visit(entry);
    return seen;
  }

  const packageRel = (file: string) => relative(PACKAGE_ROOT, file).split(sep).join("/");

  it("keeps the catalog free of runtime dependencies", () => {
    const offenders = [...reach(join(PACKAGE_ROOT, "src/catalog/index.ts"))].flatMap((file) =>
      [
        ...(packageRel(file).startsWith("src/catalog/") ? [] : [`${packageRel(file)} (outside src/catalog)`]),
        ...importsOf(file).filter((spec) => !spec.startsWith(".") && spec !== "zod").map((spec) => `${packageRel(file)}: ${spec}`),
      ],
    );
    expect(offenders).toEqual([]);
  });

  it("keeps payments, providers and node built-ins out of the main entry", () => {
    const reached = [...reach(join(PACKAGE_ROOT, "src/index.ts"))].map(packageRel);
    expect(reached.filter((file) => file.startsWith("src/payments/") || file.startsWith("src/providers/stripe/") || file === "src/testing.ts")).toEqual([]);
  });

  it("uses no Node built-in, `vitest` or `Date.now()` in source (tests and testing.ts aside)", () => {
    const offenders = srcFiles.flatMap((file) => {
      const name = packageRel(file);
      const text = readFileSync(file, "utf8");
      const problems = importsOf(file)
        .filter((spec) => spec.startsWith("node:") || (spec === "vitest" && name !== "src/testing.ts"))
        .map((spec) => `${name}: ${spec}`);
      if (name !== "src/testing.ts" && /Date\.now\(\)|new Date\(\)/.test(text.replace(/now: \(\) => new Date\(\)/, ""))) problems.push(`${name}: reads the clock`);
      return problems;
    });
    expect(offenders).toEqual([]);
  });

  it("exposes the Stripe SDK only through the ./stripe export", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { exports: Record<string, string> };
    expect(manifest.exports["./stripe"]).toBe("./src/providers/stripe/index.ts");
  });
});
