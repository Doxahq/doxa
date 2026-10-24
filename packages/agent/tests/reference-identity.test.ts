import { describe, expect, test } from "vitest";

import {
  ensureReferenceSections,
  type DocumentationStructure,
  type ProjectAnalysis,
  type RestApiReferenceEndpoint,
  type SdkApiReferenceModule,
} from "../src";
import { referenceIdentityKey } from "../src/doxa-agent/reference-surfaces";
import { DEFAULT_REFERENCE_SECTION_DEFAULTS } from "../src/doxa-agent/reference-surfaces";
import { analysisFixture } from "./fixtures";

const editorial: DocumentationStructure = {
  sections: [{
    id: "documentation",
    title: "Documentation",
    default: true,
    pages: [{
      id: "overview",
      title: "Overview",
      description: "Understand the public product and its primary user workflows.",
    }],
  }],
};

function endpoint(id: string, method: string, path: string, title: string): RestApiReferenceEndpoint {
  return {
    id,
    title,
    method,
    path,
    description: `Use ${method} ${path} through the public REST API with the documented request contract.`,
    sourceEvidence: [{ path: `src/routes/${id}.ts` }],
  };
}

function sdkModule(id: string, title: string): SdkApiReferenceModule {
  return {
    id,
    title,
    description: `Reference documentation for the public ${title} module and its supported exports.`,
    sourceEvidence: [{ path: `packages/${id}/src/index.ts` }],
    exports: [{
      id: `create-${id}`,
      name: `create${id}`,
      kind: "function",
      description: `Create the public ${title} integration.`,
      sourceEvidence: [{ path: `packages/${id}/src/index.ts` }],
    }],
  };
}

function analysis(endpoints: RestApiReferenceEndpoint[]): ProjectAnalysis {
  return {
    ...analysisFixture,
    referenceSurfaces: {
      rest: {
        label: "REST API",
        slug: "rest-api",
        description: "Manage webhooks and check the service through the public REST API.",
        sourceEvidence: [],
        groups: [{
          id: "webhooks",
          title: "Webhooks",
          description: "Create and list the webhooks that receive flag change events.",
          sourceEvidence: [],
          endpoints,
        }],
      },
      sdk: {
        label: "API Reference",
        slug: "api-reference",
        sourceEvidence: [],
        modules: [sdkModule("core", "Core evaluation engine")],
      },
    },
  };
}

const webhookEndpoints = [
  endpoint("create-webhook", "POST", "/v1/projects/{projectId}/webhooks", "Create webhook"),
  endpoint("list-webhooks", "GET", "/v1/projects/{projectId}/webhooks", "List webhooks"),
];

/** The id and title of every reference page, by section. */
function identities(structure: DocumentationStructure): string[] {
  return structure.sections.flatMap((section) =>
    section.pages.filter((page) => page.reference).map((page) => `${section.id}/${page.id} | ${page.title}`)
  );
}

/** A copy of the reference pages with new ids and titles, as an earlier buggy run stored them. */
function renamed(
  structure: DocumentationStructure,
  rename: (page: { id: string; title: string }) => { id: string; title: string },
): DocumentationStructure {
  return {
    sections: structure.sections.map((section) => ({
      ...section,
      pages: section.pages.map((page) => (page.reference ? { ...page, ...rename(page) } : page)),
    })),
  };
}

describe("reference page identity", () => {
  test("adding the reference pages again changes nothing", () => {
    const first = ensureReferenceSections(editorial, analysis(webhookEndpoints));
    // The planner echoes the published reference section back in its proposal.
    const second = ensureReferenceSections(first, analysis(webhookEndpoints));
    const third = ensureReferenceSections(second, analysis(webhookEndpoints), DEFAULT_REFERENCE_SECTION_DEFAULTS, second);

    expect(identities(second)).toEqual(identities(first));
    expect(identities(third)).toEqual(identities(first));
    expect(identities(first)).toContain("rest-api/post-v1-projects-webhooks | Create webhook");
    expect(identities(first)).toContain("api-reference/core | Core evaluation engine");
  });

  test("keeps the routes and names of the previous version for the same endpoints and modules", () => {
    const fresh = ensureReferenceSections(editorial, analysis(webhookEndpoints));
    const previous = renamed(fresh, (page) => ({ id: `kept-${page.id}`, title: `${page.title} kept` }));

    const next = ensureReferenceSections(previous, analysis(webhookEndpoints), DEFAULT_REFERENCE_SECTION_DEFAULTS, previous);

    expect(identities(next)).toEqual(identities(previous));
  });

  test("drops the qualifier that an earlier collision added to a previous name", () => {
    const fresh = ensureReferenceSections(editorial, analysis(webhookEndpoints));
    const previous = renamed(fresh, (page) => ({
      id: page.id,
      title: page.id === "core" ? `API Reference: ${page.title}` : page.id.startsWith("post-") ? `${page.title} (Webhooks)` : page.title,
    }));

    const next = ensureReferenceSections(previous, analysis(webhookEndpoints), DEFAULT_REFERENCE_SECTION_DEFAULTS, previous);

    expect(identities(next)).toEqual(identities(fresh));
  });

  test("gives a new endpoint its own route while the others keep theirs", () => {
    const previous = renamed(
      ensureReferenceSections(editorial, analysis(webhookEndpoints)),
      (page) => ({ id: `old-${page.id}`, title: page.title }),
    );
    const withLookup = [
      ...webhookEndpoints,
      endpoint("get-webhook", "GET", "/v1/projects/{projectId}/webhooks/{webhookId}", "Get webhook"),
    ];

    const next = ensureReferenceSections(previous, analysis(withLookup), DEFAULT_REFERENCE_SECTION_DEFAULTS, previous);

    expect(identities(next)).toEqual([
      "rest-api/old-index | REST API",
      "rest-api/old-webhooks | Webhooks",
      "rest-api/old-post-v1-projects-webhooks | Create webhook",
      "rest-api/old-get-v1-projects-webhooks | List webhooks",
      "rest-api/get-v1-projects-webhooks-webhook-id | Get webhook",
      "api-reference/old-core | Core evaluation engine",
    ]);
  });

  test("drops the collision mark of an earlier run on a new plan, never in a patch", () => {
    const fresh = ensureReferenceSections(editorial, analysis(webhookEndpoints));
    const marked = renamed(fresh, (page) => ({
      id: page.id === "index" ? "rest-api-index-2" : page.id === "core" ? "api-reference-core" : `rest-api-${page.id}`,
      title: page.title,
    }));

    const replanned = ensureReferenceSections(marked, analysis(webhookEndpoints), DEFAULT_REFERENCE_SECTION_DEFAULTS, marked, { dropCollisionMarks: true });
    const patched = ensureReferenceSections(marked, analysis(webhookEndpoints), DEFAULT_REFERENCE_SECTION_DEFAULTS, marked);

    expect(identities(replanned)).toEqual(identities(fresh));
    expect(identities(patched)).toEqual(identities(marked));
  });

  test("keeps the collision mark while the plain id still collides", () => {
    const twoWebhookGroups = analysis(webhookEndpoints);
    const rest = twoWebhookGroups.referenceSurfaces!.rest!;
    rest.groups.push({
      id: "Webhooks",
      title: "Webhook deliveries",
      description: "Inspect the deliveries that FlagForge made to each webhook endpoint.",
      sourceEvidence: [],
      endpoints: [endpoint("list-deliveries", "GET", "/v1/deliveries", "List deliveries")],
    });
    const first = ensureReferenceSections(editorial, twoWebhookGroups);

    const next = ensureReferenceSections(first, twoWebhookGroups, DEFAULT_REFERENCE_SECTION_DEFAULTS, first, { dropCollisionMarks: true });

    const routes = (structure: DocumentationStructure) => identities(structure).map((identity) => identity.split(" | ")[0]);
    expect(routes(first)).toContain("rest-api/rest-api-webhooks");
    expect(routes(next)).toEqual(routes(first));
  });

  test("matches an endpoint by method and path, whatever its parameter style or analysis id", () => {
    const colon = { reference: { kind: "rest" as const, pageKind: "endpoint" as const, method: "GET", path: "/v1/projects/:projectId/flags/:flagKey" } };
    const openApi = { reference: { kind: "rest" as const, pageKind: "endpoint" as const, method: "GET", path: "/v1/projects/{projectId}/flags/{flagKey}", endpointId: "other" } };

    expect(referenceIdentityKey(colon)).toBe(referenceIdentityKey(openApi));
    expect(referenceIdentityKey({ reference: { kind: "sdk", moduleId: "core" } })).toBe("sdk:module:core");
    expect(referenceIdentityKey({})).toBeNull();
  });

  test("changes the facts hash of an endpoint page only when its own facts change", () => {
    const factsHashes = (structure: DocumentationStructure) => Object.fromEntries(
      structure.sections.flatMap((section) => section.pages)
        .filter((page) => page.reference?.endpointId)
        .map((page) => [page.id, page.reference?.factsHash]),
    );
    const before = ensureReferenceSections(editorial, analysis(webhookEndpoints));
    const withNewParameter = webhookEndpoints.map((candidate) =>
      candidate.id === "list-webhooks"
        ? {
            ...candidate,
            parameters: [{ name: "limit", in: "query" as const, type: "integer", required: false }],
          }
        : candidate
    );
    const after = ensureReferenceSections(editorial, analysis(withNewParameter), DEFAULT_REFERENCE_SECTION_DEFAULTS, before);
    const movedEvidence = webhookEndpoints.map((candidate) => ({
      ...candidate,
      sourceEvidence: [{ path: `src/routes/v2/${candidate.id}.ts` }],
    }));

    expect(factsHashes(before)["post-v1-projects-webhooks"]).toMatch(/^[0-9a-f]{64}$/);
    expect(factsHashes(after)["post-v1-projects-webhooks"]).toBe(factsHashes(before)["post-v1-projects-webhooks"]);
    expect(factsHashes(after)["get-v1-projects-webhooks"]).not.toBe(factsHashes(before)["get-v1-projects-webhooks"]);
    expect(factsHashes(ensureReferenceSections(editorial, analysis(movedEvidence)))).toEqual(factsHashes(before));
  });

  test("still avoids the names of editorial pages", () => {
    const withEditorialTwin: DocumentationStructure = {
      sections: [{
        ...editorial.sections[0]!,
        pages: [
          ...editorial.sections[0]!.pages,
          { id: "core", title: "Core evaluation engine", description: "Understand how the core engine evaluates flags at runtime." },
        ],
      }],
    };

    const structure = ensureReferenceSections(withEditorialTwin, analysis(webhookEndpoints));

    expect(identities(structure)).toContain("api-reference/core | API Reference: Core evaluation engine");
  });
});
