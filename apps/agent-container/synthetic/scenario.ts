import type {
  DocumentationStructure,
  ProjectAnalysis,
} from "@doxahq/agent";

export interface SyntheticPageScenario {
  id: string;
  title: string;
  description: string;
  sourcePath: string;
}

export interface SyntheticGenerationScenario {
  seed: number;
  projectName: string;
  packageName: string;
  projectSlug: string;
  featureName: string;
  pages: SyntheticPageScenario[];
  analysis: ProjectAnalysis;
  structure: DocumentationStructure;
}

const PROJECT_NAMES = [
  "Beacon",
  "Canopy",
  "Harbor",
  "Lantern",
  "Relay",
  "Summit",
];

const FEATURES = [
  "typed message routing",
  "deterministic task scheduling",
  "validated configuration loading",
  "structured event delivery",
  "safe request retrying",
  "observable job execution",
];

export function createSyntheticScenario(
  requestedSeed: number,
): SyntheticGenerationScenario {
  const seed = normalizeSeed(requestedSeed);
  const random = mulberry32(seed);
  const projectWord = choose(PROJECT_NAMES, random);
  const featureName = choose(FEATURES, random);
  const projectName = `${projectWord} SDK`;
  const packageName = `@synthetic/${projectWord.toLowerCase()}-sdk`;
  const projectSlug = `${projectWord.toLowerCase()}-sdk`;
  const pages: SyntheticPageScenario[] = [
    {
      id: "overview",
      title: "Overview",
      description:
        `Learn how ${projectName} helps application developers use ${featureName} in their own projects.`,
      sourcePath: "src/index.ts",
    },
    {
      id: "getting-started",
      title: "Getting Started",
      description:
        `Install ${projectName}, create a client, and verify the first ${featureName} workflow.`,
      sourcePath: "README.md",
    },
  ];
  if (seed % 2 === 1) {
    pages.push({
      id: "operation-events",
      title: "Operation Events",
      description:
        `Format observable ${featureName} lifecycle events and use their status in application logs.`,
      sourcePath: "src/events.ts",
    });
  }

  const analysis: ProjectAnalysis = {
    projectName,
    projectType: "library",
    languages: ["TypeScript"],
    frameworks: [],
    entryPoints: ["src/index.ts"],
    keyFiles: ["src/index.ts", "package.json", "README.md"],
    summary:
      `${projectName} is a deterministic TypeScript library for ${featureName}.`,
    projectDescription:
      `${projectName} gives application developers a small public API for ${featureName}, with typed inputs and predictable results.`,
    projectCategory: "library",
    isMonorepo: false,
    hasReact: false,
    hasApiRoutes: false,
    hasCli: false,
    packages: [],
    cliCommands: [],
    configFiles: [
      {
        path: "package.json",
        description:
          "Defines the public package name, module type, and exported entry point.",
      },
    ],
    apiEndpoints: [],
    keyFeatures: [
      featureName,
      "typed client creation",
      "predictable operation results",
    ],
    installMethods: [`pnpm add ${packageName}`],
    externalIntegrations: [],
  };

  const structure: DocumentationStructure = {
    sections: [
      {
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: pages.map((page) => ({
          id: page.id,
          title: page.title,
          description: page.description,
          sourceEvidence: [{ path: page.sourcePath }],
        })),
      },
    ],
  };

  return {
    seed,
    projectName,
    packageName,
    projectSlug,
    featureName,
    pages,
    analysis,
    structure,
  };
}

export function syntheticPageContent(
  scenario: SyntheticGenerationScenario,
  page: SyntheticPageScenario,
): string {
  const install = `pnpm add ${scenario.packageName}`;
  if (page.id === "overview") {
    return [
      "---",
      `title: ${page.title}`,
      `description: ${page.description}`,
      "---",
      "",
      `# ${page.title}`,
      "",
      `${scenario.projectName} gives application developers a focused way to use ${scenario.featureName}. ` +
        "Its public client accepts typed options and returns a predictable result that can be logged, tested, or passed to another part of an application.",
      "",
      "## What you can build",
      "",
      "- **Typed integrations:** catch invalid inputs before an application is deployed.",
      "- **Predictable operations:** use one small client surface in scripts, services, and tests.",
      "- **Visible results:** inspect the returned status instead of relying on hidden background behavior.",
      "",
      "## How it works",
      "",
      "1. Install the package in the application that needs the integration.",
      "2. Create a client with a descriptive application name.",
      `3. Call the client to run the ${scenario.featureName} operation.`,
      "4. Check the returned result and decide what the application should do next.",
      "",
      "```ts",
      `import { createClient } from "${scenario.packageName}";`,
      "",
      'const client = createClient({ application: "checkout" });',
      'const result = await client.run("first-task");',
      "console.log(result.status);",
      "```",
      "",
      "## Next step",
      "",
      "Continue to [Getting Started](/getting-started) for installation, a complete first request, and a verification check.",
    ].join("\n");
  }

  if (page.id === "operation-events") {
    return [
      "---",
      `title: ${page.title}`,
      `description: ${page.description}`,
      "---",
      "",
      `# ${page.title}`,
      "",
      `${scenario.projectName} represents an operation lifecycle with a task name and a status. ` +
        `Use these events when an application needs a compact, observable record of ${scenario.featureName}.`,
      "",
      "## Event fields",
      "",
      "| Field | Type | Description |",
      "| --- | --- | --- |",
      "| `task` | `string` | The application-defined operation name. |",
      "| `status` | `started` or `completed` | The current lifecycle state. |",
      "",
      "## Format an event",
      "",
      "Import the formatter and pass a complete event value:",
      "",
      "```ts",
      `import { formatOperationEvent } from "${scenario.packageName}";`,
      "",
      "const line = formatOperationEvent({",
      '  task: "sync-catalog",',
      '  status: "completed",',
      "});",
      "",
      'console.log(line); // "sync-catalog:completed"',
      "```",
      "",
      "## Use events in logs",
      "",
      "Write the formatted value after the operation resolves. The stable `task:status` shape is suitable for local logs and structured logging adapters that accept a message string.",
      "",
      "Start with [Getting Started](/getting-started) if you have not created a client yet, or return to the [Overview](/overview) for the complete workflow.",
    ].join("\n");
  }

  return [
    "---",
    `title: ${page.title}`,
    `description: ${page.description}`,
    "---",
    "",
    `# ${page.title}`,
    "",
    `This guide installs ${scenario.projectName} and runs one ${scenario.featureName} operation in a TypeScript application.`,
    "",
    "## Prerequisites",
    "",
    "- Node.js 20 or newer",
    "- A project with pnpm installed",
    "- A TypeScript entry file",
    "",
    "## Install the package",
    "",
    "Run the installation command from the root of your application:",
    "",
    "```bash",
    install,
    "```",
    "",
    "The command should add the package to `dependencies` in your application's `package.json`.",
    "",
    "## Run the first operation",
    "",
    "Create a client and await the result so failures are visible to the caller:",
    "",
    "```ts",
    `import { createClient } from "${scenario.packageName}";`,
    "",
    'const client = createClient({ application: "demo" });',
    'const result = await client.run("hello-synthetic-pipeline");',
    'console.log(`operation: ${result.status}`);',
    "```",
    "",
    "## Verify the result",
    "",
    "Run your application. A successful call prints `operation: completed`. If the package cannot read the input, check that the task name is a non-empty string and that the client was created before `run` was called.",
    "",
    "Read the [Overview](/overview) to understand the client workflow and the guarantees available to callers.",
  ].join("\n");
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 1;
  return Math.max(1, Math.trunc(seed)) >>> 0;
}

function choose<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length)]!;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = state + 0x6d2b79f5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}
