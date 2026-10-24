import { describe, expect, test } from "vitest";
import { createImportResolver } from "../src/repo-map/resolve";
import {
  buildRepoMap,
  createMemoryRepoMapCache,
  createMemoryRepoMapSourceTree,
  estimateTokens,
  lexicalSymbolExtractor,
  parseRepoMapSnapshot,
  REPO_MAP_CHARS_PER_TOKEN,
  repoMapCacheKey,
  resolveRepoMap,
  type RepoMapCache,
  type RepoMapSourceTree,
  type RepoMapTelemetry,
} from "../src/repo-map";

/** A pnpm-style monorepo: two packages, an app, and root tooling. */
const MONOREPO: Record<string, string> = {
  "package.json": JSON.stringify({ name: "acme-monorepo", private: true }),
  "README.md": "# Acme\n",
  "scripts/release.mjs": "export function release() {}\n",
  "packages/core/package.json": JSON.stringify({ name: "@acme/core" }),
  "packages/core/src/index.ts": 'export * from "./client";\nexport { formatError } from "./errors";\n',
  "packages/core/src/client.ts": 'import { formatError } from "./errors";\nexport class AcmeClient {}\nexport function createClient() { return new AcmeClient(); }\n',
  "packages/core/src/errors.ts": "export function formatError(error: unknown) { return String(error); }\n",
  "packages/core/tests/client.test.ts": 'import { createClient } from "../src/client";\ntest("x", () => createClient());\n',
  "packages/ui/package.json": JSON.stringify({ name: "@acme/ui" }),
  "packages/ui/src/button.tsx": 'import { formatError } from "@acme/core";\nexport function Button() { return formatError("x"); }\n',
  "apps/api/package.json": JSON.stringify({ name: "@acme/api" }),
  "apps/api/src/server.ts": 'import { createClient } from "@acme/core";\napp.get("/v1/health", () => createClient());\nexport const server = app;\n',
  "apps/api/src/routes/users.ts": 'import { AcmeClient } from "@acme/core";\nrouter.post("/v1/users", handler);\nexport function handler() { return AcmeClient; }\n',
  "vendor/lib/huge.js": "export function vendored() {}\n",
  ".github/scripts/check.js": "export function check() {}\n",
};

async function build(files: Record<string, string>, tokenBudget = 1_500) {
  return buildRepoMap(createMemoryRepoMapSourceTree(files), { tokenBudget });
}

function areaOrder(text: string): string[] {
  return text.split("\n").flatMap((line) => /^## (\S+?)(?: \(|:)/.exec(line)?.[1] ?? []);
}

describe("repo map build", () => {
  test("groups a monorepo by package roots and labels areas with package names", async () => {
    const map = await build(MONOREPO);

    expect(map.text).toContain("## packages/core (@acme/core): 3 files");
    expect(map.text).toContain("## packages/ui (@acme/ui): 1 file");
    expect(map.text).toContain("## apps/api (@acme/api): 2 files");
    expect(map.text).toContain("## scripts: 1 file");
    // Tests, vendored code, and tool folders are not product code.
    expect(map.text).not.toContain("client.test.ts");
    expect(map.text).not.toContain("vendored");
    expect(map.text).not.toContain("check");
    expect(map.text).toContain("- src/server.ts: route GET /v1/health; const server");
  });

  test("ranks the most used package and file first", async () => {
    const map = await build(MONOREPO);
    const order = areaOrder(map.text);

    expect(order[0]).toBe("packages/core");
    const coreLines = map.text.split("\n").filter((line) => line.startsWith("- src/") && /errors|client|index/.test(line));
    // errors.ts is used by client.ts, index.ts, and (through @acme/core names) the ui package.
    expect(coreLines[0]).toBe("- src/errors.ts: fn formatError");
  });

  test("is deterministic for any listing order", async () => {
    const reversed = Object.fromEntries(Object.entries(MONOREPO).reverse());
    const first = await build(MONOREPO);
    const second = await build(MONOREPO);
    const third = await build(reversed);

    expect(second.text).toBe(first.text);
    expect(third.text).toBe(first.text);
    expect(third.stats).toEqual(first.stats);
  });

  test("splits a large single source directory one level down", async () => {
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "solo" }) };
    for (let index = 0; index < 25; index++) {
      files[`src/api/route${index}.ts`] = `export function route${index}() {}\n`;
      files[`src/core/unit${index}.ts`] = `export function unit${index}() {}\n`;
    }
    files["src/index.ts"] = 'export * from "./core/unit0";\n';

    const order = areaOrder((await build(files, 4_000)).text);
    expect(order).toEqual(expect.arrayContaining(["src/api", "src/core", "src"]));
    expect(order).not.toContain("(root)");
  });

  test("fits the token budget and keeps every area heading", async () => {
    const files: Record<string, string> = {};
    for (let area = 0; area < 6; area++) {
      files[`area${area}/package.json`] = JSON.stringify({ name: `area-${area}` });
      for (let index = 0; index < 30; index++) {
        files[`area${area}/src/module${index}.ts`] =
          `export function someLongFunctionName${index}() {}\nexport class SomeLongClassName${index} {}\n`;
      }
    }

    for (const budget of [200, 400, 800]) {
      const map = await build(files, budget);
      expect(map.text.length).toBeLessThanOrEqual(budget * REPO_MAP_CHARS_PER_TOKEN);
      expect(map.stats.tokenEstimate).toBe(estimateTokens(map.text));
      expect(map.stats.tokenEstimate).toBeLessThanOrEqual(budget);
      expect(areaOrder(map.text)).toHaveLength(6);
      expect(map.stats.renderedFileCount).toBeLessThan(180);
    }
    const small = await build(files, 200);
    const large = await build(files, 800);
    expect(large.stats.renderedFileCount).toBeGreaterThan(small.stats.renderedFileCount);
  });

  test("drops the lowest areas when headings alone exceed the budget", async () => {
    const files: Record<string, string> = {};
    for (let area = 0; area < 40; area++) {
      files[`area-with-a-long-name-${String(area).padStart(2, "0")}/index.ts`] = `export function f${area}() {}\n`;
    }
    const map = await build(files, 150);
    expect(map.text.length).toBeLessThanOrEqual(150 * REPO_MAP_CHARS_PER_TOKEN);
    expect(map.text).toMatch(/\(\+\d+ more areas not shown\)$/);
  });

  test("returns empty text when not even the header fits", async () => {
    const map = await build(MONOREPO, 10);
    expect(map.text).toBe("");
  });

  test("resolves Python, Go, and Rust imports into rank", async () => {
    const map = await build({
      "py/pyproject.toml": '[project]\nname = "acme-py"\n',
      "py/acme/__init__.py": "from .models import User\n",
      "py/acme/models.py": "class User:\n    pass\n",
      "py/acme/api.py": "from acme.models import User\nfrom . import models\n\ndef handler():\n    return User\n",
      "go/go.mod": "module github.com/acme/svc\n",
      "go/store/store.go": "package store\n\nfunc Open() {}\n",
      "go/main.go": 'package main\n\nimport "github.com/acme/svc/store"\n\nfunc Run() { store.Open() }\n',
      "rs/Cargo.toml": '[package]\nname = "acme-rs"\n',
      "rs/src/lib.rs": "pub mod config;\nuse crate::config::Settings;\npub fn start(_: Settings) {}\n",
      "rs/src/config.rs": "pub struct Settings;\n",
    }, 4_000);

    const lines = map.text.split("\n");
    const firstFileUnder = (heading: string) => lines[lines.indexOf(heading) + 1];
    expect(firstFileUnder("## py (acme-py): 3 files")).toBe("- acme/models.py: class User");
    expect(firstFileUnder("## go (github.com/acme/svc): 2 files")).toBe("- store/store.go: fn Open");
    expect(firstFileUnder("## rs (acme-rs): 2 files")).toBe("- src/config.rs: class Settings");
  });
});

describe("import resolution", () => {
  const files = [
    "packages/core/src/index.ts",
    "packages/core/src/client.ts",
    "packages/core/src/errors/index.ts",
    "apps/web/src/lib/utils.ts",
    "apps/web/src/page.tsx",
    "py/acme/__init__.py",
    "py/acme/models.py",
    "py/acme/api/routes.py",
    "go/internal/store/store.go",
    "go/internal/store/store_test.go",
    "rs/src/lib.rs",
    "rs/src/config/mod.rs",
    "rs/src/config/loader.rs",
  ];
  const resolve = createImportResolver(files, [
    { path: "packages/core", name: "@acme/core" },
    { path: "apps/web", name: "web" },
    { path: "py", name: "acme" },
    { path: "go", goModule: "github.com/acme/svc" },
    { path: "rs", name: "acme-rs" },
  ]);

  test("resolves TypeScript relative, .js-suffixed, alias, and workspace imports", () => {
    expect(resolve("packages/core/src/index.ts", "typescript", { specifier: "./client.js" })).toEqual(["packages/core/src/client.ts"]);
    expect(resolve("packages/core/src/client.ts", "typescript", { specifier: "./errors" })).toEqual(["packages/core/src/errors/index.ts"]);
    expect(resolve("apps/web/src/page.tsx", "typescript", { specifier: "~/lib/utils" })).toEqual(["apps/web/src/lib/utils.ts"]);
    expect(resolve("apps/web/src/page.tsx", "typescript", { specifier: "@acme/core" })).toEqual(["packages/core/src/index.ts"]);
    expect(resolve("apps/web/src/page.tsx", "typescript", { specifier: "@acme/core/client" })).toEqual(["packages/core/src/client.ts"]);
    expect(resolve("apps/web/src/page.tsx", "typescript", { specifier: "react" })).toEqual([]);
  });

  test("resolves Python relative and absolute imports", () => {
    expect(resolve("py/acme/api/routes.py", "python", { specifier: "..models", names: ["User"] })).toEqual(["py/acme/models.py"]);
    expect(resolve("py/acme/api/routes.py", "python", { specifier: "acme", names: ["models"] })).toEqual(["py/acme/models.py"]);
    expect(resolve("py/acme/api/routes.py", "python", { specifier: "acme.models", names: ["User"] })).toEqual(["py/acme/models.py"]);
    expect(resolve("py/acme/models.py", "python", { specifier: "os" })).toEqual([]);
  });

  test("resolves Go packages to their non-test files", () => {
    expect(resolve("go/main.go", "go", { specifier: "github.com/acme/svc/internal/store" })).toEqual(["go/internal/store/store.go"]);
    expect(resolve("go/main.go", "go", { specifier: "github.com/other/lib" })).toEqual([]);
  });

  test("resolves Rust mod declarations and crate paths", () => {
    expect(resolve("rs/src/lib.rs", "rust", { specifier: "config", kind: "module-declaration" })).toEqual(["rs/src/config/mod.rs"]);
    expect(resolve("rs/src/config/mod.rs", "rust", { specifier: "loader", kind: "module-declaration" })).toEqual(["rs/src/config/loader.rs"]);
    expect(resolve("rs/src/lib.rs", "rust", { specifier: "crate::config::loader::load" })).toEqual(["rs/src/config/loader.rs"]);
    expect(resolve("rs/src/lib.rs", "rust", { specifier: "std::collections::HashMap" })).toEqual([]);
  });
});

describe("repo map cache keys", () => {
  const entries = [
    { path: "b.ts", size: 10, mtimeMs: 2 },
    { path: "a.ts", size: 5, mtimeMs: 1 },
  ];

  test("are stable across entry order and change with every input", () => {
    const base = { source: { kind: "files" as const, entries }, extractorVersion: "lexical-v1", tokenBudget: 1_500 };
    const key = repoMapCacheKey(base);

    expect(repoMapCacheKey({ ...base, source: { kind: "files", entries: [...entries].reverse() } })).toBe(key);
    expect(key).toMatch(/^repo-map-v1-[0-9a-f]{64}$/);
    expect(repoMapCacheKey({ ...base, tokenBudget: 1_000 })).not.toBe(key);
    expect(repoMapCacheKey({ ...base, extractorVersion: "tree-sitter-v1" })).not.toBe(key);
    expect(repoMapCacheKey({
      ...base,
      source: { kind: "files", entries: [{ ...entries[0], mtimeMs: 3 }, entries[1]] },
    })).not.toBe(key);
  });

  test("use the snapshot tree hash when one is known", () => {
    const input = { extractorVersion: "lexical-v1", tokenBudget: 1_500 };
    const tree = repoMapCacheKey({ ...input, source: { kind: "tree", treeHash: "abc123" } });
    expect(repoMapCacheKey({ ...input, source: { kind: "tree", treeHash: "abc123" } })).toBe(tree);
    expect(repoMapCacheKey({ ...input, source: { kind: "tree", treeHash: "abc124" } })).not.toBe(tree);
    // Pinned: a new value invalidates every stored map, so change it only with REPO_MAP_FORMAT_VERSION.
    expect(tree).toBe("repo-map-v1-c1baa2d90829470d98c7608d17b8d385c2b590f09c87ce819d022ec188caea37");
  });
});

describe("repo map resolution", () => {
  function countingTree(files: Record<string, string>): RepoMapSourceTree & { lists: number; reads: number } {
    const inner = createMemoryRepoMapSourceTree(files);
    const tree = {
      lists: 0,
      reads: 0,
      async list() {
        tree.lists += 1;
        return inner.list();
      },
      async readText(path: string) {
        tree.reads += 1;
        return inner.readText(path);
      },
    };
    return tree;
  }

  test("builds once and serves the cached snapshot by tree hash without listing", async () => {
    const cache = createMemoryRepoMapCache();
    const telemetry: RepoMapTelemetry[] = [];
    const tree = countingTree(MONOREPO);
    const options = { cache, sourceTreeHash: "tree-1", onTelemetry: (event: RepoMapTelemetry) => { telemetry.push(event); } };

    const built = await resolveRepoMap(tree, options);
    const listsAfterBuild = tree.lists;
    const readsAfterBuild = tree.reads;
    const cached = await resolveRepoMap(tree, options);

    expect(built?.text).toContain("REPOSITORY MAP");
    expect(cached).toEqual(built);
    expect(tree.lists).toBe(listsAfterBuild);
    expect(tree.reads).toBe(readsAfterBuild);
    expect(telemetry.map((event) => event.status === "ready" && event.cacheHit)).toEqual([false, true]);
    const first = telemetry[0];
    if (first.status !== "ready") throw new Error("expected a ready map");
    expect(first.stats).toMatchObject({ sourceFileCount: 8, areaCount: 4 });
    expect(first.stats.symbolCount).toBeGreaterThan(5);
    expect(first.stats.tokenEstimate).toBe(estimateTokens(built?.text ?? ""));
  });

  test("keys local builds by the file fingerprint", async () => {
    const cache = createMemoryRepoMapCache();
    const first = await resolveRepoMap(createMemoryRepoMapSourceTree(MONOREPO), { cache });
    const changed = await resolveRepoMap(
      createMemoryRepoMapSourceTree({ ...MONOREPO, "apps/api/src/extra.ts": "export function extra() {}\n" }),
      { cache },
    );
    expect(changed?.key).not.toBe(first?.key);
    expect(changed?.text).toContain("extra");
  });

  test("returns null and reports why when the repository is over the limits", async () => {
    const telemetry: RepoMapTelemetry[] = [];
    const map = await resolveRepoMap(createMemoryRepoMapSourceTree(MONOREPO), {
      limits: { maxSourceFiles: 3 },
      onTelemetry: (event) => { telemetry.push(event); },
    });
    expect(map).toBeNull();
    expect(telemetry).toEqual([
      expect.objectContaining({ status: "skipped", reason: expect.stringContaining("exceed the repo map limit") }),
    ]);
  });

  test("survives a failing cache, extractor, and telemetry sink", async () => {
    const brokenCache: RepoMapCache = {
      get: async () => { throw new Error("cache down"); },
      set: async () => { throw new Error("cache down"); },
    };
    const map = await resolveRepoMap(createMemoryRepoMapSourceTree(MONOREPO), {
      cache: brokenCache,
      onTelemetry: () => { throw new Error("sink down"); },
    });
    expect(map?.text).toContain("REPOSITORY MAP");

    const failing = await resolveRepoMap(createMemoryRepoMapSourceTree(MONOREPO), {
      extractor: { version: "broken", extract: () => { throw new Error("extractor bug"); } },
    });
    expect(failing).toBeNull();
  });

  test("ignores a cached snapshot stored under another key", async () => {
    const stale = await resolveRepoMap(createMemoryRepoMapSourceTree(MONOREPO), { sourceTreeHash: "old" });
    if (!stale) throw new Error("expected a map");
    const cache: RepoMapCache = { get: async () => stale, set: async () => {} };
    const telemetry: RepoMapTelemetry[] = [];
    await resolveRepoMap(createMemoryRepoMapSourceTree(MONOREPO), {
      cache,
      sourceTreeHash: "new",
      onTelemetry: (event) => { telemetry.push(event); },
    });
    expect(telemetry[0]).toMatchObject({ status: "ready", cacheHit: false });
  });

  test("validates snapshots read back from an external store", async () => {
    const map = await resolveRepoMap(createMemoryRepoMapSourceTree(MONOREPO), { sourceTreeHash: "t" });
    const roundTripped = parseRepoMapSnapshot(JSON.parse(JSON.stringify(map)));
    expect(roundTripped).toEqual(map);
    expect(parseRepoMapSnapshot({ ...map, formatVersion: 999 })).toBeNull();
    expect(parseRepoMapSnapshot({ text: "x" })).toBeNull();
  });

  test("exposes the lexical extractor version used in keys", () => {
    expect(lexicalSymbolExtractor.version).toBe("lexical-v1");
  });
});
