import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { executeTool } from "../src/core/tool";
import { globTool } from "../src/core/tools/glob";
import { grepTool } from "../src/core/tools/grep";
import {
  ProjectPathAccessError,
  resolveProjectPath,
} from "../src/core/tools/project-path";
import { readTool } from "../src/core/tools/read";

describe("project path containment", () => {
  let projectRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "doxa-project-root-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "doxa-outside-root-"));

    await mkdir(join(projectRoot, "src"), { recursive: true });
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "src/index.ts"), "export const safe = true;\n", "utf8");
    await writeFile(join(projectRoot, ".git/config"), "private git configuration\n", "utf8");
    await writeFile(join(outsideRoot, "secret.txt"), "outside secret value\n", "utf8");
  });

  afterEach(async () => {
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  });

  test("resolves existing and not-yet-created paths below the project root", async () => {
    const canonicalRoot = await realpath(projectRoot);

    await expect(resolveProjectPath(projectRoot, "src/index.ts"))
      .resolves.toBe(join(canonicalRoot, "src/index.ts"));
    await expect(resolveProjectPath(projectRoot, "generated/pages/overview.mdx"))
      .resolves.toBe(join(canonicalRoot, "generated/pages/overview.mdx"));
  });

  test("accepts an output directory created concurrently with path resolution", async () => {
    const canonicalRoot = await realpath(projectRoot);

    for (let iteration = 0; iteration < 25; iteration++) {
      const directory = `generated-${iteration}`;
      const resolutions = Array.from({ length: 8 }, (_, page) =>
        resolveProjectPath(projectRoot, `${directory}/page-${page}.mdx`)
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await mkdir(join(projectRoot, directory), { recursive: true });

      await expect(Promise.all(resolutions)).resolves.toEqual(
        Array.from({ length: 8 }, (_, page) =>
          join(canonicalRoot, directory, `page-${page}.mdx`)
        ),
      );
    }
  });

  test.each([
    ["an absolute outside path", () => join(outsideRoot, "secret.txt")],
    ["parent traversal", () => "../secret.txt"],
  ])("rejects %s", async (_name, requestedPath) => {
    await expect(resolveProjectPath(projectRoot, requestedPath()))
      .rejects.toMatchObject({
        code: "PROJECT_PATH_ACCESS_DENIED",
      });
  });

  test("rejects a symlink that escapes the project root", async () => {
    await symlink(join(outsideRoot, "secret.txt"), join(projectRoot, "src/escape.txt"));

    await expect(resolveProjectPath(projectRoot, "src/escape.txt"))
      .rejects.toBeInstanceOf(ProjectPathAccessError);
  });

  test("rejects a broken symlink instead of treating it as a new path", async () => {
    await symlink(
      join(outsideRoot, "not-created-yet.txt"),
      join(projectRoot, "src/broken-link.txt"),
    );

    await expect(resolveProjectPath(projectRoot, "src/broken-link.txt"))
      .rejects.toBeInstanceOf(ProjectPathAccessError);
  });

  test("rejects .git paths directly and through a symlink", async () => {
    await symlink(join(projectRoot, ".git"), join(projectRoot, "git-data"));

    await expect(resolveProjectPath(projectRoot, ".git/config"))
      .rejects.toBeInstanceOf(ProjectPathAccessError);
    await expect(resolveProjectPath(projectRoot, "git-data/config"))
      .rejects.toBeInstanceOf(ProjectPathAccessError);
  });

  test.each([
    ["Read", () => readTool(projectRoot), { path: () => join(outsideRoot, "secret.txt") }],
    ["Glob", () => globTool(projectRoot), { pattern: () => "**/*", path: () => outsideRoot }],
    ["Grep", () => grepTool(projectRoot), { pattern: () => "secret", path: () => outsideRoot }],
  ])("%s denies outside paths without returning file contents", async (_name, createTool, rawArgs) => {
    const args = Object.fromEntries(
      Object.entries(rawArgs).map(([key, getValue]) => [key, getValue()]),
    );
    const result = await executeTool([createTool()], _name, JSON.stringify(args));

    expect(result).toContain("PROJECT_PATH_ACCESS_DENIED");
    expect(result).not.toContain("outside secret value");
  });
});
