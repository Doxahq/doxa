/**
 * ARTIFACT COMPATIBILITY GATE (render side)
 *
 * The renderer is evergreen: one build serves every published site. This
 * suite takes the golden route data that the docs runtime produced for every
 * frozen artifact set, parses each page's MDX with the current runtime, and
 * renders it with the portable runtime component registry. That registry is
 * kept key-for-key aligned with the routed template registry by
 * `runtime.test.ts`, which compares names only.
 *
 * A failure here means an already-published page no longer parses,
 * validates, or renders, or its set of MDX components changed. This suite
 * does NOT exercise the production components in `src/lib/components.ts`,
 * so it cannot catch a production component that drops an old prop. See the
 * deferred decision in the compatibility contract.
 *
 * Do not relax an assertion or edit a frozen set to make this suite pass.
 * Keep every old component and prop working, or get explicit approval for
 * the behavior change first.
 *
 * See `docs/current/docs-artifact-compatibility.md`.
 */
import { readFileSync } from "node:fs";

import React from "react";
import {
  listFrozenArtifactSets,
  routeDataSnapshotFileName,
  type FrozenArtifactSet,
} from "@doxahq/docs-artifact-fixtures";
import {
  RUNTIME_MDX_COMPONENT_NAMES,
  type RuntimeMdxDocument,
  type RuntimeMdxNode,
  type RuntimeMdxParseOptions,
} from "@doxahq/mdx-runtime";
import { getDocsHighlighter } from "@doxahq/mdx-runtime/highlight";
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, test } from "vitest";

import { preparePublicDocsRouteData } from "./prerender-renderer";
import { RuntimeMdxContent } from "./runtime-mdx-content";
import type { DoxaDocsRuntimeSource, RuntimeRouteData } from "./runtime-source";

let highlighter: RuntimeMdxParseOptions["highlighter"];

beforeAll(async () => {
  highlighter = await getDocsHighlighter();
});

describe.each(listFrozenArtifactSets())(
  "frozen set $name (schema v$schemaVersion)",
  (set) => {
    test.each(set.manifest.pages.map((page) => [page.href]))(
      "page %s parses, validates, and renders with the current template",
      async (href) => {
        const routeData = readGoldenRouteData(set, href);
        const source = createPinnedSource(routeData);

        const prepared = await preparePublicDocsRouteData(source, href, {
          highlighter,
        });

        expect(prepared.type).toBe("page");
        if (prepared.type !== "page") return;
        expect(prepared.runtimeDocument?.ok, href).toBe(true);
        if (!prepared.runtimeDocument?.ok) return;

        const html = renderToString(
          React.createElement(RuntimeMdxContent, {
            document: prepared.runtimeDocument.document,
          })
        );
        expect(html.length).toBeGreaterThan(0);

        await expect(
          `${JSON.stringify(collectComponentNames(prepared.runtimeDocument.document), null, 2)}\n`
        ).toMatchFileSnapshot(
          set.expectedPath("components", routeDataSnapshotFileName(href))
        );
      }
    );
  }
);

function readGoldenRouteData(
  set: FrozenArtifactSet,
  href: string
): RuntimeRouteData {
  const golden = JSON.parse(
    readFileSync(set.expectedRouteDataPath(href), "utf8")
  ) as { ok: boolean; data: RuntimeRouteData };
  if (!golden.ok) {
    throw new Error(
      `Golden route data for ${set.name} ${href} records a failure; run the docs-runtime compatibility gate first.`
    );
  }
  return golden.data;
}

/**
 * A source that only answers the one-shot route data call. Every other
 * operation is a loader waterfall the production path must never take.
 */
function createPinnedSource(
  routeData: RuntimeRouteData
): DoxaDocsRuntimeSource {
  const unsupported = async (): Promise<never> => {
    throw new Error("The pinned source only supports getRouteData.");
  };
  return {
    getRouteData: async () => routeData,
    getSiteConfig: unsupported,
    getCompanyConfig: unsupported,
    getSocialConfig: unsupported,
    getThemeConfig: unsupported,
    getFeatureConfig: unsupported,
    getSections: unsupported,
    getNavigation: unsupported,
    getRoutes: unsupported,
    getHomeHref: unsupported,
    resolvePage: unsupported,
    getPage: unsupported,
    getRawPage: unsupported,
    getSearchIndex: unsupported,
  };
}

/** The sorted, unique MDX component names a document uses. */
function collectComponentNames(document: RuntimeMdxDocument): string[] {
  const componentNames = new Set<string>(RUNTIME_MDX_COMPONENT_NAMES);
  const used = new Set<string>();
  const visit = (nodes: readonly RuntimeMdxNode[]): void => {
    for (const node of nodes) {
      if (node.type !== "element") continue;
      if (componentNames.has(node.name)) used.add(node.name);
      if (node.children) visit(node.children);
    }
  };
  visit(document.nodes);
  return [...used].sort();
}
