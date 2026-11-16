import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Billing spec 6.2 and AGENTS.md: `@doxahq/billing/payments`, `/stripe` and
 * `stripe` are for the API Node origin only. `doxa-mcp` and
 * `doxa-docs-resolver` build from `apps/api` as Workers, so no file that a
 * Worker entry reaches may import them or anything under `runtime/node`.
 */
const API_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const NODE_RUNTIME = join(API_ROOT, "src", "runtime", "node") + sep;
const FORBIDDEN = (spec: string) => spec === "stripe" || spec.startsWith("stripe/") || spec.startsWith("@doxahq/billing/payments") || spec.startsWith("@doxahq/billing/stripe");
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

const apiExports = (JSON.parse(readFileSync(join(API_ROOT, "package.json"), "utf8")) as { exports: Record<string, string> }).exports;

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8").replace(/^\s*import\s+type\s[^;]+;/gm, "");
  return [...text.matchAll(IMPORT)].map((match) => match[1] ?? "");
}

function resolveFile(base: string): string | null {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // next candidate
    }
  }
  return null;
}

function resolveSpec(from: string, spec: string): string | null {
  if (spec.startsWith(".")) return resolveFile(resolve(dirname(from), spec));
  if (spec.startsWith("@doxahq/api/")) {
    const target = apiExports[`./${spec.slice("@doxahq/api/".length)}`];
    return target ? resolveFile(join(API_ROOT, target.replace(/\.ts$/, ""))) : null;
  }
  return null;
}

/** Every file an entry reaches through relative and `@doxahq/api/*` imports (value imports only). */
function reach(entries: readonly string[]): { files: Set<string>; offenders: string[] } {
  const files = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of importsOf(file)) {
      if (FORBIDDEN(spec)) offenders.push(`${relative(REPO_ROOT, file)}: ${spec}`);
      const target = resolveSpec(file, spec);
      if (target) visit(target);
    }
  };
  entries.forEach(visit);
  return { files, offenders };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const WORKER_ENTRIES = {
  "doxa-api Worker (src/index.ts)": [join(API_ROOT, "src", "index.ts")],
  "doxa-docs-resolver (src/docs-resolver.ts)": [join(API_ROOT, "src", "docs-resolver.ts")],
  "doxa-mcp (apps/mcp/src)": sourceFiles(join(REPO_ROOT, "apps", "mcp", "src")),
};

describe("billing import boundaries of the Worker builds", () => {
  it.each(Object.entries(WORKER_ENTRIES))("%s reaches no payments, Stripe or Node-origin code", (_name, entries) => {
    const { files, offenders } = reach(entries);
    expect(files.size).toBeGreaterThan(entries.length);
    expect(offenders).toEqual([]);
    expect([...files].filter((file) => file.startsWith(NODE_RUNTIME)).map((file) => relative(REPO_ROOT, file))).toEqual([]);
  });

  it("the Worker API still reaches the billing seams (so the check is not empty)", () => {
    const { files } = reach(WORKER_ENTRIES["doxa-api Worker (src/index.ts)"]);
    expect(files.has(join(API_ROOT, "src", "services", "billing", "plan-seams.ts"))).toBe(true);
    expect(files.has(join(API_ROOT, "src", "routes", "billing.ts"))).toBe(true);
  });

  it("the credit meter, the MCP billing and the hosting tier reach the Worker builds without payments", () => {
    const billing = (name: string) => join(API_ROOT, "src", "services", "billing", name);
    expect(reach(WORKER_ENTRIES["doxa-api Worker (src/index.ts)"]).files.has(billing("generation-metering.ts"))).toBe(true);
    expect(reach(WORKER_ENTRIES["doxa-mcp (apps/mcp/src)"]).files.has(billing("mcp-billing.ts"))).toBe(true);
    expect(reach(WORKER_ENTRIES["doxa-docs-resolver (src/docs-resolver.ts)"]).files.has(billing("hosting-tier.ts"))).toBe(true);
  });

  it("only src/runtime/node imports @doxahq/billing/payments in apps/api/src", () => {
    const offenders = sourceFiles(join(API_ROOT, "src"))
      .filter((file) => !file.startsWith(NODE_RUNTIME))
      .flatMap((file) => importsOf(file).filter(FORBIDDEN).map((spec) => `${relative(REPO_ROOT, file)}: ${spec}`));
    expect(offenders).toEqual([]);
  });
});
