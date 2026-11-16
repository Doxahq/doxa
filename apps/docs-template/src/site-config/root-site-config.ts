import { hashSiteConfig, toClientSiteConfig } from "@doxahq/site-config";
import { createServerFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";

import type { DocsRequestContext } from "../runtime/request-context";
import { createConfiguredRuntimeSource } from "../runtime/runtime-source-selection";
import { loadSiteConfig } from "./load-site-config";
import { siteHead } from "./site-head";

export const loadRootSiteConfig = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const requestContext: DocsRequestContext = context ?? {};
    const config =
      requestContext.siteConfig ??
      (await loadSiteConfig(
        requestContext.runtimeSource ?? (await createConfiguredRuntimeSource())
      ));
    return {
      config: toClientSiteConfig(config),
      configHash: await hashSiteConfig(config),
      // The host that the site resolved from, as in runtime-source-selection.ts.
      head: siteHead(config, getRequestUrl({ xForwardedHost: false }).origin),
      delivery: requestContext.delivery ?? null,
    };
  }
);
