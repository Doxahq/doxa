import type { DocumentationStructure } from "@doxahq/agent";
import { MAX_TEMPLATE_WRITE_GROUP_PAGES, MAX_WRITE_GROUP_PAGES } from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import { GenerationStageInvariantError } from "../src/generation-stage-errors";
import { assertWriteGroupSize } from "../src/write-group-size";

const ENDPOINT_COUNT = MAX_TEMPLATE_WRITE_GROUP_PAGES;
const GUIDE_COUNT = MAX_WRITE_GROUP_PAGES + 1;

const structure: DocumentationStructure = {
  sections: [
    {
      id: "api",
      title: "REST API",
      pages: Array.from({ length: ENDPOINT_COUNT }, (_, index) => ({
        id: `endpoint-${index}`,
        title: `Endpoint ${index}`,
        description: `Endpoint ${index}.`,
        reference: { kind: "rest" as const, groupId: "items", endpointId: `endpoint-${index}` },
      })),
    },
    {
      id: "guides",
      title: "Guides",
      default: true,
      pages: Array.from({ length: GUIDE_COUNT }, (_, index) => ({
        id: `guide-${index}`,
        title: `Guide ${index}`,
        description: `Guide ${index}.`,
      })),
    },
  ],
};

const endpointPageIds = Array.from({ length: ENDPOINT_COUNT }, (_, index) => `api/endpoint-${index}`);
const guidePageIds = Array.from({ length: GUIDE_COUNT }, (_, index) => `guides/guide-${index}`);

describe("write group size", () => {
  test("accepts a model group up to the model group limit", () => {
    expect(() => assertWriteGroupSize(structure, guidePageIds.slice(0, MAX_WRITE_GROUP_PAGES))).not.toThrow();
  });

  test("accepts a large group when a template renders every page", () => {
    expect(() => assertWriteGroupSize(structure, endpointPageIds)).not.toThrow();
  });

  test("rejects a large group that holds model pages", () => {
    const pageIds = [...endpointPageIds.slice(0, MAX_WRITE_GROUP_PAGES), guidePageIds[0]!];

    expect(() => assertWriteGroupSize(structure, pageIds)).toThrow(GenerationStageInvariantError);
    expect(() => assertWriteGroupSize(structure, pageIds)).toThrow(/holds 1 model-written pages/);
  });

  test("rejects a model group over the model group limit", () => {
    expect(() => assertWriteGroupSize(structure, guidePageIds)).toThrow(
      expect.objectContaining({ code: "write_group_too_large" }),
    );
  });
});
