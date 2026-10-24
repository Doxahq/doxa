import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { discoverSpecFiles } from "../../src/reference-specs/discovery";
import { readSpecFile } from "../../src/reference-specs/file-gate";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function checkout(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doxa-spec-checkout-"));
  directories.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe("spec discovery", () => {
  test("finds known names and spec files under api folders, and skips tests, fixtures and links", async () => {
    const outside = await checkout({ "openapi.yaml": "openapi: 3.1.0\npaths: {}\n" });
    const root = await checkout({
      "openapi.yaml": "openapi: 3.1.0\npaths: {}\n",
      "services/orders.openapi.json": '{\n  "openapi": "3.0.3",\n  "paths": {}\n}',
      "api/v1.json": '{"info":{"title":"Minified"},"openapi":"3.2.0","paths":{}}',
      "docs/config.yaml": "theme: dark\n",
      "swagger.yml": "swagger: '2.0'\npaths: {}\n",
      "tests/fixtures/openapi.yaml": "openapi: 3.1.0\npaths: {}\n",
      "examples/api/openapi.yaml": "openapi: 3.1.0\npaths: {}\n",
      "node_modules/pkg/openapi.yaml": "openapi: 3.1.0\npaths: {}\n",
      ".github/openapi.yaml": "openapi: 3.1.0\npaths: {}\n",
      "src/openapi.ts": "export const openapi = '3.1.0';\n",
    });
    await symlink(join(outside, "openapi.yaml"), join(root, "linked-openapi.yaml"));

    await expect(discoverSpecFiles(root)).resolves.toEqual([
      "api/v1.json",
      "openapi.yaml",
      "services/orders.openapi.json",
      "swagger.yml",
    ]);
  });

  test("finds the version of a spec with sorted keys after the first 4 KB", async () => {
    const schemas = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`Model${index}`, { type: "object" }]));
    const sorted = JSON.stringify({ components: { schemas }, info: { title: "Sorted" }, openapi: "3.0.0", paths: {} });
    const root = await checkout({ "openapi/spec3.json": sorted, "docs/data.json": JSON.stringify({ items: schemas }) });

    expect(sorted.indexOf('"openapi"')).toBeGreaterThan(4 * 1024);
    await expect(discoverSpecFiles(root)).resolves.toEqual(["openapi/spec3.json"]);
  });

  test("keeps a known spec name over the size limit so that gate G1 reports it", async () => {
    const root = await checkout({ "openapi.json": "{", "docs/big.json": "{" });
    await truncate(join(root, "openapi.json"), 25 * 1024 * 1024 + 1);
    await truncate(join(root, "docs/big.json"), 25 * 1024 * 1024 + 1);

    await expect(discoverSpecFiles(root)).resolves.toEqual(["openapi.json"]);
  });

  test("uses only the configured paths when the project names them", async () => {
    const root = await checkout({ "openapi.yaml": "openapi: 3.1.0\n", "public/api.yaml": "openapi: 3.1.0\n" });

    await expect(discoverSpecFiles(root, ["public/api.yaml"])).resolves.toEqual(["public/api.yaml"]);
  });
});

describe("gate G1", () => {
  test("reads UTF-8 text, removes the BOM and uses \\n line endings", async () => {
    const root = await checkout({ "openapi.yaml": "﻿openapi: 3.1.0\r\npaths: {}\r\n" });

    await expect(readSpecFile(root, "openapi.yaml")).resolves.toEqual({ ok: true, text: "openapi: 3.1.0\npaths: {}\n" });
  });

  test.each([
    ["a parent path", "../outside.yaml", "invalid_path"],
    ["an absolute path", "/etc/passwd.yaml", "invalid_path"],
    ["a file that is not JSON or YAML", "secrets.env", "invalid_path"],
    ["Git metadata", ".git/config.yaml", "outside_checkout"],
  ])("T2 T3 refuses %s", async (_label, path, refusal) => {
    const root = await checkout({ "openapi.yaml": "openapi: 3.1.0\n" });

    await expect(readSpecFile(root, path)).resolves.toEqual({ ok: false, refusal });
  });

  test("T1 refuses links that leave the checkout and links inside it", async () => {
    const outside = await checkout({ "spec/openapi.yaml": "openapi: 3.1.0\n" });
    const root = await checkout({ "openapi.yaml": "openapi: 3.1.0\n" });
    await symlink(join(outside, "spec/openapi.yaml"), join(root, "outside-link.yaml"));
    await symlink(join(outside, "spec"), join(root, "linked"));
    await symlink(join(root, "openapi.yaml"), join(root, "inside-link.yaml"));

    await expect(readSpecFile(root, "outside-link.yaml")).resolves.toEqual({ ok: false, refusal: "outside_checkout" });
    await expect(readSpecFile(root, "linked/openapi.yaml")).resolves.toEqual({ ok: false, refusal: "outside_checkout" });
    await expect(readSpecFile(root, "inside-link.yaml")).resolves.toEqual({ ok: false, refusal: "symbolic_link" });
  });

  test("T5 refuses NUL bytes and invalid UTF-8", async () => {
    const root = await checkout({
      "nul.yaml": new Uint8Array([111, 0, 112]),
      "latin1.yaml": new Uint8Array([0x6f, 0xe9, 0x0a]),
    });

    await expect(readSpecFile(root, "nul.yaml")).resolves.toEqual({ ok: false, refusal: "nul_byte" });
    await expect(readSpecFile(root, "latin1.yaml")).resolves.toEqual({ ok: false, refusal: "not_utf8" });
  });

  test("T4 refuses a file larger than 25 MB", async () => {
    const root = await checkout({ "huge.yaml": "openapi: 3.1.0\n" });
    await truncate(join(root, "huge.yaml"), 25 * 1024 * 1024 + 1);

    await expect(readSpecFile(root, "huge.yaml")).resolves.toEqual({ ok: false, refusal: "too_large" });
  });
});

describe("spec names in planning", () => {
  test.each([
    "openapi.yaml",
    "swagger.json",
    "openapi.v2.yml",
    "services/orders.openapi.json",
    "src/billing/swagger-public.yaml",
  ])("treats %s as structural, as discovery treats it as a spec", async (path) => {
    const { isStructuralSourcePath } = await import("../../src/state/source-changes");
    const { isCandidatePath } = await import("../../src/reference-specs/discovery");

    expect(isCandidatePath(path)).toBe(true);
    expect(isStructuralSourcePath(path)).toBe(true);
  });
});
