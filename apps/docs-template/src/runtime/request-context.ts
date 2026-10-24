import type { PublicDocsRouteDataV1 } from "@doxahq/contracts/docs-prerender";
import type { ResolvedSiteConfig } from "@doxahq/site-config";

import type { DoxaDocsRuntimeSource } from "./runtime-source";
import type { RuntimeSourceMode } from "./runtime-source-selection";

export interface DocsPreparedRoute {
  pathname: string;
  data: PublicDocsRouteDataV1;
}

export interface DocsDeliveryCapability {
  mode: "public-production";
  renderId: string;
  schemaVersion: 1;
}

export interface DocsRequestContext {
  siteConfig?: ResolvedSiteConfig;
  delivery?: DocsDeliveryCapability;
  preparedRoute?: DocsPreparedRoute;
  runtimeSource?: DoxaDocsRuntimeSource;
  runtimeSourceMode?: RuntimeSourceMode;
}

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: DocsRequestContext;
    };
  }
}
