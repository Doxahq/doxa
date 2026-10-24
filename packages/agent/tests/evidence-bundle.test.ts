import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ProjectPathAccessError } from "../src/core/tools/project-path";
import { buildPageEvidenceBundle } from "../src/doxa-agent/evidence-bundle";
import type {
  DocPage,
  ProjectAnalysis,
} from "../src/types";
import type { WriterHandoffPageBrief } from "../src/doxa-agent/writer-handoff";
import { analysisFixture } from "./fixtures";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("page evidence bundle", () => {
  test("reads declared evidence before inferred evidence with deterministic caps", async () => {
    const project = await temporaryProject({
      "src/declared.ts": "DECLARED-ABCDEFGHIJ",
      "src/handoff.ts": "HANDOFF-ABCDEFGHIJ",
      "src/inferred.ts": "INFERRED-ABCDEFGHIJ",
    });
    const page = pageFixture({
      sourceEvidence: [{
        path: "src/declared.ts",
        kind: "source",
        title: "Declared",
      }],
      reference: { kind: "sdk", moduleId: "client" },
    });
    const analysis = analysisWithSdkEvidence("src/inferred.ts");

    const first = await buildPageEvidenceBundle({
      cwd: project,
      page,
      analysis,
      handoffBrief: {
        pageId: "client",
        title: "Client",
        route: "/client",
        pageType: "reference",
        purpose: "Use the public client.",
        requiredTopics: ["Create and configure the client."],
        sourceEvidence: [{
          path: "src/handoff.ts",
          symbols: ["createClient"],
          reason: "Planner-selected implementation.",
        }],
        relatedPageIds: [],
        exclusions: [],
      },
      maxFileChars: 12,
      maxTotalChars: 26,
    });
    const second = await buildPageEvidenceBundle({
      cwd: project,
      page,
      analysis,
      handoffBrief: {
        pageId: "client",
        title: "Client",
        route: "/client",
        pageType: "reference",
        purpose: "Use the public client.",
        requiredTopics: ["Create and configure the client."],
        sourceEvidence: [{
          path: "src/handoff.ts",
          symbols: ["createClient"],
          reason: "Planner-selected implementation.",
        }],
        relatedPageIds: [],
        exclusions: [],
      },
      maxFileChars: 12,
      maxTotalChars: 26,
    });

    expect(first).toEqual(second);
    expect(first.paths).toEqual([
      "src/declared.ts",
      "src/handoff.ts",
      "src/inferred.ts",
    ]);
    expect(first.context).toContain("DECLARED-ABC");
    expect(first.context).toContain("HANDOFF-ABCD");
    expect(first.context).toContain("IN");
    expect(first.context.indexOf("src/declared.ts")).toBeLessThan(
      first.context.indexOf("src/handoff.ts"),
    );
    expect(first.context.indexOf("src/handoff.ts")).toBeLessThan(
      first.context.indexOf("src/inferred.ts"),
    );
    expect(evidenceContentChars(first.context)).toBeLessThanOrEqual(26);
    expect(first.sufficient).toBe(true);
  });

  test("skips missing and unreadable evidence and reports the skipped paths", async () => {
    const project = await temporaryProject({
      "src/readable.ts": "export const value = 1;",
    });
    await mkdir(join(project, "src", "directory.ts"));

    const bundle = await buildPageEvidenceBundle({
      cwd: project,
      page: pageFixture({
        sourceEvidence: [
          { path: "src/missing.ts" },
          { path: "src/directory.ts" },
          { path: "src/readable.ts" },
        ],
      }),
      analysis: analysisFixture,
      handoffBrief: {
        pageId: "client",
        title: "Client",
        route: "/client",
        pageType: "documentation",
        purpose: "Use the public client.",
        requiredTopics: ["Create the client."],
        sourceEvidence: [{
          path: "src/readable.ts",
          symbols: [],
          reason: "Readable evidence.",
        }],
        relatedPageIds: [],
        exclusions: [],
      },
    });

    expect(bundle.paths).toEqual(["src/readable.ts"]);
    expect(bundle.reason).toContain("src/missing.ts");
    expect(bundle.reason).toContain("src/directory.ts");
    expect(bundle.sufficient).toBe(true);
  });

  test("rejects evidence paths that escape the project root", async () => {
    const project = await temporaryProject({});

    await expect(
      buildPageEvidenceBundle({
        cwd: project,
        page: pageFixture({
          sourceEvidence: [{ path: "../outside.ts" }],
        }),
        analysis: analysisFixture,
      }),
    ).rejects.toBeInstanceOf(ProjectPathAccessError);
  });

  test("is insufficient without readable evidence or a handoff brief", async () => {
    const project = await temporaryProject({});

    const bundle = await buildPageEvidenceBundle({
      cwd: project,
      page: pageFixture({ sourceEvidence: [] }),
      analysis: analysisFixture,
    });

    expect(bundle.paths).toEqual([]);
    expect(bundle.context).toBe("");
    expect(bundle.sufficient).toBe(false);
    expect(bundle.reason).toContain("No readable evidence files");
  });
});

describe("page evidence bundle inferred from analysis", () => {
  const deployGuide = pageFixture({
    id: "deploy",
    title: "Deploy to production",
    description: "Deploy the service and verify the deployment.",
    sourceEvidence: [],
  });

  test("qualifies a guide page with README sections on its topic", async () => {
    const project = await temporaryProject({
      "README.md": longReadme(),
    });

    const bundle = await buildPageEvidenceBundle({
      cwd: project,
      page: deployGuide,
      analysis: { ...analysisFixture, keyFiles: ["README.md", "src/index.ts"] },
      handoffBrief: guideBrief("deploy", []),
    });

    expect(bundle.paths).toEqual(["README.md"]);
    expect(bundle.sufficient).toBe(true);
    expect(bundle.reason).toContain("analysis evidence on the page topic");
    expect(bundle.context).toContain("sections: Deploy to production");
    expect(bundle.context).toContain("wrangler deploy --env production");
    expect(bundle.context).not.toContain("UNRELATED-FILLER");
    expect(evidenceContentChars(bundle.context)).toBeLessThanOrEqual(4_000);
  });

  test("leaves out key Markdown files without a section on the page topic", async () => {
    const project = await temporaryProject({
      "README.md": "# Fixture\n\n## Contributing\n\nOpen a pull request.",
    });

    const bundle = await buildPageEvidenceBundle({
      cwd: project,
      page: deployGuide,
      analysis: { ...analysisFixture, keyFiles: ["README.md"] },
      handoffBrief: guideBrief("deploy", []),
    });

    expect(bundle.paths).toEqual([]);
    expect(bundle.sufficient).toBe(false);
    expect(bundle.reason).not.toContain("README.md");
  });

  test("adds collection item and topic workflow evidence and skips internal paths", async () => {
    const project = await temporaryProject({
      "packages/kv/README.md": "KV-ITEM-EVIDENCE",
      "src/deploy.ts": "DEPLOY-WORKFLOW-EVIDENCE",
      "src/billing.ts": "BILLING-WORKFLOW-EVIDENCE",
      "internal/DEPLOY.md": "## Deploy\n\nINTERNAL-DEPLOY-NOTES",
    });
    const analysis: ProjectAnalysis = {
      ...analysisFixture,
      keyFiles: ["internal/DEPLOY.md"],
      documentationCollections: [{
        id: "packages",
        title: "Packages",
        kind: "package",
        sourceEvidence: [],
        items: [{
          id: "kv",
          title: "KV",
          slug: "kv",
          sourceEvidence: [{ path: "packages/kv/README.md", kind: "readme" }],
        }],
      }],
      documentationIntent: {
        audience: "consumer",
        primaryUseCase: "Deploy services.",
        publicPackageNames: [],
        canonicalWorkflows: [
          workflow("Production deployment", ["src/deploy.ts"]),
          workflow("Billing setup", ["src/billing.ts"]),
        ],
        internalOnlyPaths: ["internal/"],
        consumerTerminology: [],
      },
    };

    const bundle = await buildPageEvidenceBundle({
      cwd: project,
      page: { ...deployGuide, collectionId: "packages", collectionItemId: "kv" },
      analysis,
      handoffBrief: guideBrief("deploy", []),
    });

    expect(bundle.paths).toEqual(["packages/kv/README.md", "src/deploy.ts"]);
    expect(bundle.context).toContain("Production deployment workflow evidence");
    expect(bundle.context).not.toContain("BILLING");
    expect(bundle.context).not.toContain("INTERNAL-DEPLOY-NOTES");
    expect(bundle.sufficient).toBe(true);
  });

  test("keeps inferred evidence inside the total budget after declared evidence", async () => {
    const files: Record<string, string> = {
      "src/declared.ts": "D".repeat(5_000),
    };
    const keyFiles: string[] = [];
    for (let index = 0; index < 9; index++) {
      const path = `docs/deploy-${index}.md`;
      files[path] = `## Deploy step ${index}\n\n${"deploy ".repeat(900)}`;
      keyFiles.push(path);
    }
    const project = await temporaryProject(files);
    const input = {
      cwd: project,
      page: { ...deployGuide, sourceEvidence: [{ path: "src/declared.ts" }] },
      analysis: { ...analysisFixture, keyFiles },
      handoffBrief: guideBrief("deploy", []),
      maxFileChars: 3_000,
      maxTotalChars: 10_000,
    };

    const first = await buildPageEvidenceBundle(input);
    const second = await buildPageEvidenceBundle(input);

    expect(first).toEqual(second);
    expect(first.paths).toEqual([
      "src/declared.ts",
      "docs/deploy-0.md",
      "docs/deploy-1.md",
      "docs/deploy-2.md",
    ]);
    expect(first.context.indexOf("src/declared.ts")).toBeLessThan(
      first.context.indexOf("docs/deploy-0.md"),
    );
    expect(evidenceContentChars(first.context)).toBeLessThanOrEqual(10_000);
  });

  test("reads at most six inferred files", async () => {
    const files: Record<string, string> = {};
    const keyFiles: string[] = [];
    for (let index = 0; index < 9; index++) {
      const path = `docs/deploy-${index}.md`;
      files[path] = `## Deploy step ${index}\n\nDeploy the service.`;
      keyFiles.push(path);
    }
    const project = await temporaryProject(files);

    const bundle = await buildPageEvidenceBundle({
      cwd: project,
      page: deployGuide,
      analysis: { ...analysisFixture, keyFiles },
      handoffBrief: guideBrief("deploy", []),
    });

    expect(bundle.paths).toHaveLength(6);
  });
});

function guideBrief(
  pageId: string,
  sourceEvidence: WriterHandoffPageBrief["sourceEvidence"],
): WriterHandoffPageBrief {
  return {
    pageId,
    title: "Deploy to production",
    route: `/${pageId}`,
    pageType: "documentation",
    purpose: "Deploy the service and verify the deployment.",
    requiredTopics: ["Deploy the service and verify the deployment."],
    sourceEvidence,
    relatedPageIds: [],
    exclusions: [],
  };
}

function workflow(
  name: string,
  sourceEvidence: string[],
): NonNullable<ProjectAnalysis["documentationIntent"]>["canonicalWorkflows"][number] {
  return {
    name,
    installCommands: [],
    requiredFiles: [],
    canonicalImports: [],
    envVars: [],
    routePaths: [],
    verificationSteps: [],
    sourceEvidence,
  };
}

function longReadme(): string {
  return [
    "# Fixture",
    "",
    "A fixture service.",
    "",
    "## Contributing",
    "",
    "UNRELATED-FILLER ".repeat(400),
    "",
    "## Deploy to production",
    "",
    "Run `wrangler deploy --env production` and verify the deployment.",
    "",
    "```bash",
    "## a comment, not a heading",
    "wrangler deploy --env production",
    "```",
    "",
    "## License",
    "",
    "UNRELATED-FILLER ".repeat(100),
  ].join("\n");
}

async function temporaryProject(
  files: Record<string, string>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "doxa-evidence-bundle-"));
  temporaryDirectories.push(directory);
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(directory, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  return directory;
}

function pageFixture(overrides: Partial<DocPage>): DocPage {
  return {
    id: "client",
    title: "Client",
    description: "Create and configure the public client.",
    sourceEvidence: [],
    ...overrides,
  };
}

function analysisWithSdkEvidence(path: string): ProjectAnalysis {
  return {
    ...analysisFixture,
    referenceSurfaces: {
      sdk: {
        sourceEvidence: [],
        modules: [{
          id: "client",
          title: "Client",
          sourceEvidence: [{ path, kind: "source" }],
          exports: [],
        }],
      },
    },
  };
}

function evidenceContentChars(context: string): number {
  return context
    .split("\n\n---\n\n")
    .reduce((total, section) => {
      const lines = section.split("\n");
      return total + lines.slice(3).join("\n").length;
    }, 0);
}
