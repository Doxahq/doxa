import { describe, expect, test } from "vitest";
import {
  ensureReferenceSections,
  flattenStructure,
  normalizeProjectAnalysis,
  stablePageId,
  type DocumentationStructure,
  type ProjectAnalysis,
  type RestApiReferenceEndpoint,
} from "@doxahq/agent";

import { patchPublishedStructure } from "../src/structure-patch";

function endpoint(id: string, method: string, path: string, title: string): RestApiReferenceEndpoint {
  return {
    id,
    title,
    method,
    path,
    description: `Use ${method} ${path} through the public REST API with the documented request contract.`,
    sourceEvidence: [{ path: "apps/api/src/routes/environments.routes.ts" }],
  };
}

function analysis(endpoints: RestApiReferenceEndpoint[]): ProjectAnalysis {
  return normalizeProjectAnalysis({
    projectName: "FlagForge",
    projectCategory: "api-service",
    referenceSurfaces: {
      rest: {
        label: "REST API",
        slug: "rest-api",
        description: "Manage projects and environments through the self-hosted FlagForge HTTP API.",
        sourceEvidence: [],
        groups: [{
          id: "environments",
          title: "Environments",
          description: "Create and list the environments of a FlagForge project.",
          sourceEvidence: [],
          endpoints,
        }],
      },
    },
  });
}

const listEnvironments = endpoint("list", "GET", "/v1/projects/{projectId}/environments", "List environments");
const createEnvironment = endpoint("create", "POST", "/v1/projects/{projectId}/environments", "Create environment");
const getEnvironment = endpoint("get", "GET", "/v1/projects/{projectId}/environments/{environmentKey}", "Get environment");

const editorial: DocumentationStructure = {
  sections: [{
    id: "default",
    title: "Documentation",
    default: true,
    pages: [
      {
        id: "projects-and-environments",
        title: "Projects and environments",
        description: "Organize flags by project and environment and choose the keys each environment uses.",
        sourceEvidence: [{ path: "apps/api/src/routes/environments.routes.ts", kind: "source", title: "Routes" }],
      },
    ],
  }],
};

/** The live site of FlagForge: reference routes carry the section prefix from an earlier run. */
function publishedSite(): DocumentationStructure {
  const fresh = ensureReferenceSections(editorial, analysis([listEnvironments, createEnvironment]));
  return {
    sections: fresh.sections.map((section) => ({
      ...section,
      pages: section.pages.map((page) => (page.reference ? { ...page, id: `rest-api-${page.id}` } : page)),
    })),
  };
}

describe("structure patch", () => {
  test("keeps every published page and route, and adds the new endpoint", () => {
    const published = publishedSite();

    const patch = patchPublishedStructure(published, analysis([listEnvironments, createEnvironment, getEnvironment]));

    expect(patch.structure.sections[0]).toEqual(published.sections[0]);
    expect(patch.addedPageIds).toEqual(["rest-api/get-v1-projects-environments-environment-key"]);
    expect(patch.removedPageIds).toEqual([]);
    const publishedIds = flattenStructure(published).map(stablePageId);
    expect(flattenStructure(patch.structure).map(stablePageId).filter((id) => publishedIds.includes(id))).toEqual(publishedIds);
  });

  test("removes the page of an endpoint that the code no longer serves", () => {
    const patch = patchPublishedStructure(publishedSite(), analysis([listEnvironments]));

    expect(patch.removedPageIds).toEqual(["rest-api/rest-api-post-v1-projects-environments"]);
    expect(patch.addedPageIds).toEqual([]);
  });

  test("keeps out a reference page that an earlier review merged away", () => {
    const withAuth = (endpoints: RestApiReferenceEndpoint[]): ProjectAnalysis => {
      const value = analysis(endpoints);
      return {
        ...value,
        referenceSurfaces: {
          ...value.referenceSurfaces,
          rest: {
            ...value.referenceSurfaces!.rest!,
            authSchemes: [{ scheme: "bearer", location: "header", name: "Authorization", description: "Send an API key as a bearer token." }],
          },
        },
      };
    };
    // The published site has no auth page: the review merged it into the overview.
    const published = publishedSite();

    const patch = patchPublishedStructure(
      published,
      withAuth([listEnvironments, createEnvironment, getEnvironment]),
      withAuth([listEnvironments, createEnvironment]),
    );

    expect(patch.addedPageIds).toEqual(["rest-api/get-v1-projects-environments-environment-key"]);
  });

  test("leaves the published reference sections when the analysis has none", () => {
    const published = publishedSite();

    const patch = patchPublishedStructure(published, normalizeProjectAnalysis({ projectName: "FlagForge" }));

    expect(patch.structure).toEqual(published);
  });
});
