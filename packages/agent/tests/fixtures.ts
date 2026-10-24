import type { DocumentationStructure, ProjectAnalysis } from "../src";

export const analysisFixture: ProjectAnalysis = {
  projectName: "Fixture",
  projectType: "library",
  languages: ["TypeScript"],
  frameworks: [],
  entryPoints: ["src/index.ts"],
  keyFiles: ["src/index.ts"],
  summary: "A small fixture project.",
  projectDescription: "A small fixture project used by @doxahq/agent tests.",
  projectCategory: "library",
  isMonorepo: false,
  hasReact: false,
  hasApiRoutes: false,
  hasCli: false,
  packages: [],
  cliCommands: [],
  configFiles: [],
  apiEndpoints: [],
  keyFeatures: ["Exports a function"],
  installMethods: ["pnpm add fixture"],
  externalIntegrations: [],
};

export const structureFixture: DocumentationStructure = {
  sections: [
    {
      id: "default",
      title: "Documentation",
      default: true,
      pages: [
        {
          id: "overview",
          title: "Overview",
          description: "Project overview.",
          sourceEvidence: [{ path: "src/index.ts" }],
        },
        {
          id: "guides",
          title: "Guides",
          description: "Guides parent.",
          sourceEvidence: [{ path: "src/guides.ts" }],
        },
        {
          id: "guides/install",
          title: "Install",
          description: "Install guide.",
          group: "Guides",
          sourceEvidence: [{ path: "package.json" }],
        },
      ],
    },
  ],
};
