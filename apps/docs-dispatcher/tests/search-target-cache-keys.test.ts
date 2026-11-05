import type { DocsDomainResolution } from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
  DurableObject: class {},
}));

import {
  createHtmlCacheCall,
  createRouteDataCacheCall,
  createSavedOutputCall,
} from "../src/public-cache-calls";
import { createTextCacheProps } from "../src/text-cache-policy";
import { resolution } from "./fixtures/simulated-cache";

/**
 * PRODUCT REGRESSION GUARDRAIL. The resolution is part of every public page
 * cache key. A search change must not change those keys: it would make the pages
 * of the site cold, and a field on every resolution would do that to every site
 * at the deploy.
 */
const withSearchTarget: DocsDomainResolution = {
  ...resolution,
  searchProvider: "typesense",
  searchIndexKey: `s_${"1".repeat(32)}_${"2".repeat(32)}_abcdef01abcdef01abcdef01abcdef01`,
};

const ORIGIN = "https://docs.example.com";
const IDENTITY = { renderId: "r" } as never;

describe("public page cache keys ignore the search target", () => {
  test("HTML", () => {
    const call = (target: DocsDomainResolution) =>
      createHtmlCacheCall({
        url: `${ORIGIN}/guide`,
        method: "GET",
        resolution: target,
        rendererBuildId: "build",
        deliveryRenderId: null,
        lifetime: "versioned",
      }).props;
    expect(call(withSearchTarget)).toEqual(call(resolution));
  });

  test("saved output", () => {
    const call = (target: DocsDomainResolution) =>
      createSavedOutputCall({
        origin: ORIGIN,
        pathname: "/guide",
        resolution: target,
        identity: IDENTITY,
        featureMode: "all",
        representation: "html",
      }).props;
    expect(call(withSearchTarget)).toEqual(call(resolution));
  });

  test("route data", () => {
    const call = (target: DocsDomainResolution) =>
      createRouteDataCacheCall({
        origin: ORIGIN,
        pathname: "/guide",
        resolution: target,
        identity: IDENTITY,
      }).props;
    expect(call(withSearchTarget)).toEqual(call(resolution));
  });

  test("text routes", () => {
    const call = (target: DocsDomainResolution) =>
      createTextCacheProps(new Request(`${ORIGIN}/llms.txt`), target, {
        rendererBuildId: "build",
        deliveryRenderId: null,
        route: "llms",
      });
    expect(call(withSearchTarget)).toEqual(call(resolution));
  });
});
