import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The privacy plan's code rules, each checked by a test: the PostHog SDKs
 * stay in their composition roots, and docs sites that Doxa hosts for its
 * customers never load analytics.
 */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-node", "build", ".wrangler", ".turbo", ".output", ".tanstack", ".vinxi", "coverage", ".git"]);
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

/** Apps that serve customer docs sites or run their requests. They must never load analytics. */
const DOCS_SITE_APPS = [
  "apps/docs-template/",
  "apps/docs-runtime/",
  "apps/docs-dispatcher/",
  "apps/docs-prerenderer/",
  "apps/try-proxy/",
  "apps/search-gateway/",
];

/** The only places that build a PostHog sink. */
const POSTHOG_SINK_ROOTS = ["apps/api/src/runtime/", "apps/mcp/src/", "apps/api/src/services/analytics/"];

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
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SOURCE_FILE.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const rel = (file: string) => relative(REPO_ROOT, file).split(sep).join("/");
const repoFiles = [...walk(join(REPO_ROOT, "apps")), ...walk(join(REPO_ROOT, "packages"))].map((file) => ({
  path: rel(file),
  imports: [...readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? ""),
}));

function offenders(fileFilter: (path: string) => boolean, importFilter: (specifier: string) => boolean): string[] {
  return repoFiles
    .filter((file) => fileFilter(file.path))
    .flatMap((file) => file.imports.filter(importFilter).map((specifier) => `${file.path}: ${specifier}`));
}

const isAnalyticsImport = (specifier: string) =>
  specifier.startsWith("@doxahq/analytics") || specifier.startsWith("posthog-js") || specifier.startsWith("posthog-node");

describe("analytics import boundaries", () => {
  it("finds the repo source files", () => {
    expect(repoFiles.length).toBeGreaterThan(100);
  });

  it("keeps analytics out of every app that serves customer docs sites", () => {
    expect(offenders((path) => DOCS_SITE_APPS.some((app) => path.startsWith(app)), isAnalyticsImport)).toEqual([]);
  });

  it("imports posthog-node only in the PostHog sink", () => {
    const sinkDir = "packages/analytics/src/providers/posthog/";
    expect(offenders((path) => !path.startsWith(sinkDir) && !path.startsWith("packages/analytics/tests/"), (specifier) => specifier.startsWith("posthog-node"))).toEqual([]);
  });

  it("imports posthog-js only in apps/web", () => {
    expect(offenders((path) => !path.startsWith("apps/web/"), (specifier) => specifier.startsWith("posthog-js"))).toEqual([]);
  });

  it("builds the PostHog sink only in a composition root", () => {
    expect(
      offenders(
        (path) => !path.startsWith("packages/analytics/") && !POSTHOG_SINK_ROOTS.some((root) => path.startsWith(root)),
        (specifier) => specifier === "@doxahq/analytics/posthog",
      ),
    ).toEqual([]);
  });

  it("keeps the package root free of SDKs", () => {
    const rootFiles = repoFiles.filter(
      (file) => file.path.startsWith("packages/analytics/src/") && !file.path.startsWith("packages/analytics/src/providers/posthog/"),
    );
    expect(rootFiles.flatMap((file) => file.imports.filter((specifier) => specifier.startsWith("posthog")))).toEqual([]);
  });
});
