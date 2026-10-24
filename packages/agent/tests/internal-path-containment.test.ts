import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Provider } from "../src/core";
import { ProjectPathAccessError } from "../src/core/tools/project-path";
import { runIncrementalAnalysis } from "../src/doxa-agent/analysis-runner";
import { generateDocumentation } from "../src/doxa-agent/generation-service";
import { readExistingPages } from "../src/doxa-agent/page-io";
import {
  buildSourceEvidenceContext,
  saveWriterDebugAttempt,
} from "../src/doxa-agent/writer";
import type { AgentConfig, DocPage } from "../src/types";
import { structureFixture } from "./fixtures";

describe("internal path containment", () => {
  let projectRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "doxa-internal-root-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "doxa-internal-outside-"));

    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(
      join(projectRoot, "src/index.ts"),
      "const safeEvidence = true;\n",
      "utf8",
    );
    await writeFile(
      join(outsideRoot, "secret.txt"),
      "outside secret value\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  });

  test("writer evidence reads valid project files", async () => {
    const context = await buildSourceEvidenceContext(
      projectRoot,
      pageWithEvidence("src/index.ts"),
    );

    expect(context).toContain("safeEvidence = true");
  });

  test.each([
    ["traversal", () => relative(projectRoot, join(outsideRoot, "secret.txt"))],
    ["escaping symlink", () => "src/secret-link.txt"],
  ])("writer evidence rejects %s", async (_name, evidencePath) => {
    await symlink(
      join(outsideRoot, "secret.txt"),
      join(projectRoot, "src/secret-link.txt"),
    );

    const read = buildSourceEvidenceContext(
      projectRoot,
      pageWithEvidence(evidencePath()),
    );

    await expect(read).rejects.toBeInstanceOf(ProjectPathAccessError);
    await expect(read).rejects.not.toThrow("outside secret value");
  });

  test("incremental analysis rejects an untrusted changed-file path before calling the provider", async () => {
    let providerCalled = false;
    const provider = rejectingProvider(() => {
      providerCalled = true;
    });
    const config: AgentConfig = {
      cwd: projectRoot,
      toolPolicy: "read_only",
    };

    const analysis = runIncrementalAnalysis(provider, config, {
      needsReanalysis: true,
      cachedAnalysis: {},
      cachedExplorationContext: "",
      currentCommitHash: "test",
      changedFiles: [relative(projectRoot, join(outsideRoot, "secret.txt"))],
      addedFiles: [],
      deletedFiles: [],
    });

    await expect(analysis).rejects.toBeInstanceOf(ProjectPathAccessError);
    expect(providerCalled).toBe(false);
  });

  test("cached page reads reject paths outside the output directory", async () => {
    const outputDir = join(projectRoot, "output");
    await mkdir(outputDir);

    const read = readExistingPages(outputDir, [{
      sectionTitle: "Docs",
      page: pageWithEvidence("src/index.ts"),
      path: relative(outputDir, join(outsideRoot, "secret.txt")),
    }]);

    await expect(read).rejects.toBeInstanceOf(ProjectPathAccessError);
  });

  test("generation rejects a repository-controlled output symlink before provider use", async () => {
    await symlink(outsideRoot, join(projectRoot, ".doxa-generated"));

    const generation = generateDocumentation(
      {
        cwd: projectRoot,
        toolPolicy: "read_only",
        outputDir: ".doxa-generated",
      },
      structureFixture,
    );

    await expect(generation).rejects.toBeInstanceOf(ProjectPathAccessError);
    expect(await readdir(outsideRoot)).toEqual(["secret.txt"]);
  });

  test("writer diagnostics reject repository-controlled symlinks", async () => {
    await symlink(outsideRoot, join(projectRoot, ".doxa"));

    const write = saveWriterDebugAttempt(
      projectRoot,
      "Overview",
      1,
      "untrusted model output",
      "validation failed",
    );

    await expect(write).rejects.toBeInstanceOf(ProjectPathAccessError);
    expect(await readdir(outsideRoot)).toEqual(["secret.txt"]);
  });
});

function pageWithEvidence(path: string): DocPage {
  return {
    id: "overview",
    title: "Overview",
    description: "Project overview.",
    sourceEvidence: [{ path }],
  };
}

function rejectingProvider(onCall: () => void): Provider {
  return {
    config: {
      baseUrl: "https://example.test",
      apiKey: "test",
      model: "test",
    },
    async chat() {
      onCall();
      throw new Error("Provider must not be called.");
    },
    async *chatStream() {
      onCall();
      throw new Error("Provider must not be called.");
    },
  };
}
