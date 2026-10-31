import { describe, expect, test, vi } from "vitest";
import { applyCollectionsToStructure } from "../src/utils/documentation-collections";
import { normalizeProjectAnalysis } from "../src";
import type { DocumentationStructure, ProjectAnalysis } from "../src";
import { analysisFixture } from "./fixtures";

const memoryItems = [
  "Project Brief",
  "Product Context",
  "Tech Context",
  "System Patterns",
  "Active Context",
  "Progress",
];

function memoryBankAnalysis(): ProjectAnalysis {
  return {
    ...analysisFixture,
    projectCategory: "desktop-app",
    projectProfile: "application",
    documentationCollections: [
      {
        id: "memory-bank-files",
        title: "Memory Bank Files",
        kind: "docs",
        sourceEvidence: [{ path: "README.md", kind: "readme" }],
        items: memoryItems.map((title) => ({
          id: `memory-bank-files/${title.toLowerCase().replace(/\s+/g, "-")}`,
          title,
          slug: title.toLowerCase().replace(/\s+/g, "-"),
          sourceEvidence: [{ path: `memory-bank/${title}.md`, kind: "docs" }],
        })),
      },
    ],
  };
}

function memoryBankStructure(): DocumentationStructure {
  return {
    sections: [
      {
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: memoryItems.map((title) => ({
          id: `memory-bank-files/${title.toLowerCase().replace(/\s+/g, "-")}`,
          title,
          description: `Understand the public purpose and expected contents of ${title}.`,
          group: "Memory Bank Files",
          collectionId: "memory-bank-files",
        })),
      },
    ],
  };
}

function analysisWithDuplicatedRestCollection(): ProjectAnalysis {
  const groups = ["Users", "Projects", "Environments", "Audit Logs"].map((title) => {
    const path = `src/http/${title.toLowerCase().replace(/\s+/g, "-")}.ts`;
    return {
      id: title.toLowerCase().replace(/\s+/g, "-"),
      title,
      sourceEvidence: [{ path, kind: "source" as const }],
      endpoints: [{
        id: `get-${title.toLowerCase().replace(/\s+/g, "-")}`,
        title: `List ${title}`,
        method: "GET",
        path: `/v1/${title.toLowerCase().replace(/\s+/g, "-")}`,
        description: `List ${title.toLowerCase()}.`,
        sourceEvidence: [{ path, kind: "source" as const }],
      }],
    };
  });

  return {
    ...analysisFixture,
    projectCategory: "api",
    projectProfile: "api",
    hasApiRoutes: true,
    documentationCollections: [{
      id: "rest-api-resource-groups",
      title: "REST API resource groups",
      kind: "docs",
      sourceEvidence: [{ path: "src/http", kind: "source" }],
      items: groups.map((group) => ({
        id: group.id,
        title: group.title,
        slug: group.id,
        sourceEvidence: group.sourceEvidence,
      })),
    }],
    referenceSurfaces: {
      rest: {
        label: "REST API",
        slug: "rest-api",
        sourceEvidence: [{ path: "src/http", kind: "source" }],
        groups,
      },
    },
  };
}

describe("REST reference normalization", () => {
  test("normalizes source-evidenced REST request and response metadata", () => {
    const normalized = normalizeProjectAnalysis({
      ...analysisWithDuplicatedRestCollection(),
      referenceSurfaces: {
        rest: {
          label: "REST API",
          slug: "rest-api",
          baseUrl: "https://api.example.com/v1",
          servers: ["https://backup.example.com/v1"],
          authSchemes: [
            {
              scheme: "bearer",
              location: "header",
              name: "Authorization",
              description: "Use an issued access token.",
            },
            { scheme: "unsupported" },
          ],
          playground: { enabled: false, reason: "CORS is not enabled." },
          sourceEvidence: [],
          groups: [{
            id: "users",
            title: "Users",
            sourceEvidence: [],
            endpoints: [{
              id: "get-user",
              title: "Get a user",
              method: "GET",
              path: "/users/:userId",
              description: "Return one user.",
              parameters: [{
                name: "userId",
                in: "path",
                type: "string",
                required: true,
                enumValues: ["current"],
              }],
              bodyFields: [{ name: "profile.name", type: "string", required: false }],
              bodyContentType: "application/json",
              responses: [{
                status: 200,
                contentType: "application/json",
                fields: [{ name: "id", type: "string", required: true }],
              }],
              authRequirement: { scheme: "bearer", location: "header", name: "Authorization" },
              sourceEvidence: [],
            }],
          }],
        },
      },
    });

    expect(normalized.referenceSurfaces?.rest).toMatchObject({
      baseUrl: "https://api.example.com/v1",
      servers: ["https://backup.example.com/v1"],
      authSchemes: [{
        scheme: "bearer",
        location: "header",
        name: "Authorization",
        description: "Use an issued access token.",
      }],
      playground: { enabled: false, reason: "CORS is not enabled." },
      groups: [{
        endpoints: [{
          path: "/users/{userId}",
          parameters: [{ name: "userId", in: "path", required: true }],
          bodyFields: [{ name: "profile.name", required: false }],
          responses: [{ status: 200, fields: [{ name: "id", required: true }] }],
          authRequirement: { scheme: "bearer", name: "Authorization" },
        }],
      }],
    });
  });

  test("does not promote legacy endpoint lists into a REST reference surface", () => {
    const normalized = normalizeProjectAnalysis({
      ...analysisFixture,
      projectCategory: "desktop-app",
      projectProfile: "application",
      hasApiRoutes: true,
      apiEndpoints: [
        { method: "GET", path: "/health", description: "Local extension health check" },
      ],
    });

    expect(normalized.referenceSurfaces?.rest).toBeUndefined();
  });
});

describe("semantic documentation collections", () => {
  test("creates one normal grouped page for every Memory Bank file", () => {
    const structure = applyCollectionsToStructure(memoryBankStructure(), memoryBankAnalysis());
    const memoryPages = structure.sections[0]?.pages.filter(
      (page) => page.collectionId === "memory-bank-files",
    );

    expect(memoryPages).toHaveLength(6);
    expect(memoryPages?.every((page) => page.collectionId === "memory-bank-files")).toBe(true);
    expect(memoryPages?.every((page) => page.group === "Memory Bank Files")).toBe(true);
  });
});

describe("reference collection de-duplication", () => {
  test("drops a REST collection that restates reference groups and logs why", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const normalized = normalizeProjectAnalysis(analysisWithDuplicatedRestCollection());

      expect(normalized.documentationCollections).toEqual([]);
      expect(normalized.referenceSurfaces?.rest?.groups).toHaveLength(4);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        'Dropped documentation collection "REST API resource groups" because its items overlap REST API reference groups by title and source evidence paths',
      ));
    } finally {
      warning.mockRestore();
    }
  });

  test("keeps a genuine provider collection beside a REST reference surface", () => {
    const analysis = analysisWithDuplicatedRestCollection();
    analysis.documentationCollections = [{
      id: "providers",
      title: "Providers",
      kind: "package",
      sourceEvidence: [{ path: "packages/providers", kind: "package" }],
      items: ["AWS", "Azure", "Cloudflare", "GCP"].map((title) => ({
        id: title.toLowerCase(),
        title,
        slug: title.toLowerCase(),
        sourceEvidence: [{ path: `packages/providers/${title.toLowerCase()}/package.json`, kind: "package" }],
      })),
    }];

    const normalized = normalizeProjectAnalysis(analysis);

    expect(normalized.documentationCollections?.map((collection) => collection.id)).toEqual(["providers"]);
    expect(normalized.referenceSurfaces?.rest?.groups).toHaveLength(4);
  });

  test("keeps adapters that only share REST resource names and parent evidence", () => {
    const analysis = analysisWithDuplicatedRestCollection();
    analysis.documentationCollections = [{
      id: "resource-adapters",
      title: "Resource Adapters",
      kind: "package",
      sourceEvidence: [{ path: "src", kind: "source" }],
      items: ["User Adapters", "Project Adapters", "Environment Adapters"].map((title) => ({
        id: title.toLowerCase().replace(/\s+/g, "-"),
        title,
        slug: title.toLowerCase().replace(/\s+/g, "-"),
        sourceEvidence: [],
      })),
    }];
    analysis.referenceSurfaces!.rest!.sourceEvidence = [{ path: "src", kind: "source" }];
    analysis.referenceSurfaces!.rest!.groups = analysis.referenceSurfaces!.rest!.groups.slice(0, 3);

    const normalized = normalizeProjectAnalysis(analysis);

    expect(normalized.documentationCollections?.map((collection) => collection.id)).toEqual([
      "resource-adapters",
    ]);
  });

  test("drops a fully overlapping small REST collection", () => {
    const analysis = analysisWithDuplicatedRestCollection();
    analysis.documentationCollections![0]!.items = analysis.documentationCollections![0]!.items.slice(0, 2);
    analysis.referenceSurfaces!.rest!.groups = analysis.referenceSurfaces!.rest!.groups.slice(0, 2);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const normalized = normalizeProjectAnalysis(analysis);

      expect(normalized.documentationCollections).toEqual([]);
      expect(normalized.referenceSurfaces?.rest?.groups).toHaveLength(2);
    } finally {
      warning.mockRestore();
    }
  });

  test("uses collection-level evidence when duplicate items omit their own evidence", () => {
    const analysis = analysisWithDuplicatedRestCollection();
    analysis.documentationCollections![0]!.items = analysis.documentationCollections![0]!.items.map((item) => ({
      ...item,
      sourceEvidence: [],
    }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const normalized = normalizeProjectAnalysis(analysis);

      expect(normalized.documentationCollections).toEqual([]);
    } finally {
      warning.mockRestore();
    }
  });

  test("normalizes duplicate reference collections deterministically across runs", () => {
    const input = analysisWithDuplicatedRestCollection();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const first = normalizeProjectAnalysis(input);
      const second = normalizeProjectAnalysis(input);
      const repeated = normalizeProjectAnalysis(first);

      expect(second).toEqual(first);
      expect(repeated).toEqual(first);
    } finally {
      warning.mockRestore();
    }
  });
});
