import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "vitest";
import { createNodeArtifactStore, createNodeWorkspaceAdapter } from "../src/adapters/node";
import { ProjectPathAccessError } from "../src/core/tools/project-path";

describe("node adapters", () => {
  test("read, list, grep, hash, write, and prune local files", async () => {
    const root = await mkdtemp(join(tmpdir(), "doxa-agent-node-"));
    try {
      await writeFile(join(root, "index.ts"), "export const answer = 42;\n", "utf-8");
      await writeFile(join(root, "README.md"), "# Fixture\n", "utf-8");

      const workspace = createNodeWorkspaceAdapter(root);
      expect(await workspace.readText("index.ts")).toContain("answer");
      expect(await workspace.listFiles({ glob: "**/*.ts" })).toEqual(["index.ts"]);
      expect(await workspace.grep("answer")).toEqual([
        { path: "index.ts", line: 1, text: "export const answer = 42;" },
      ]);
      expect(await workspace.hashFile("index.ts")).toMatch(/^[a-f0-9]{64}$/);

      const artifacts = createNodeArtifactStore(join(root, "artifacts"));
      await artifacts.writeText("docs/overview.mdx", "# Overview\n");
      await artifacts.writeText("docs/stale.mdx", "# Stale\n");
      expect(await readFile(join(root, "artifacts/docs/overview.mdx"), "utf-8")).toBe("# Overview\n");
      expect(await artifacts.prune?.(["docs/overview.mdx"], "docs")).toEqual(["docs/stale.mdx"]);
      expect(await artifacts.list("docs")).toEqual([
        expect.objectContaining({ path: "docs/overview.mdx" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("workspace reads reject sibling-prefix traversal and escaping symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "doxa-agent-workspace-"));
    const siblingRoot = `${root}-secrets`;
    await mkdir(siblingRoot);

    try {
      await writeFile(
        join(siblingRoot, "key.txt"),
        "outside secret value\n",
        "utf-8",
      );
      await symlink(
        join(siblingRoot, "key.txt"),
        join(root, "secret-link.txt"),
      );

      const workspace = createNodeWorkspaceAdapter(root);
      await expect(
        workspace.readText(`../${basename(siblingRoot)}/key.txt`),
      ).rejects.toBeInstanceOf(ProjectPathAccessError);
      await expect(
        workspace.hashFile("secret-link.txt"),
      ).rejects.toBeInstanceOf(ProjectPathAccessError);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(siblingRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("artifact writes reject traversal and escaping symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "doxa-agent-artifacts-"));
    const outsideRoot = `${root}-outside`;
    const artifactRoot = join(root, "artifacts");
    await Promise.all([
      mkdir(join(artifactRoot, "docs"), { recursive: true }),
      mkdir(outsideRoot),
    ]);

    try {
      const outsideFile = join(outsideRoot, "target.mdx");
      await writeFile(outsideFile, "# Outside\n", "utf-8");
      await symlink(
        outsideFile,
        join(artifactRoot, "docs/escape.mdx"),
      );

      const artifacts = createNodeArtifactStore(artifactRoot);
      await expect(
        artifacts.writeText(
          `../${basename(outsideRoot)}/traversal.mdx`,
          "# Traversal\n",
        ),
      ).rejects.toBeInstanceOf(ProjectPathAccessError);
      await expect(
        artifacts.writeText("docs/escape.mdx", "# Overwritten\n"),
      ).rejects.toBeInstanceOf(ProjectPathAccessError);
      expect(await readFile(outsideFile, "utf-8")).toBe("# Outside\n");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outsideRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
