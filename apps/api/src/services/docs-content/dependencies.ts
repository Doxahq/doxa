import type { Env } from "../../env";
import { DocsBranchesRepository } from "../../repositories/docs-branches";
import { productAnalyticsOf } from "../analytics/product-analytics";
import { planSeamsFromEnv } from "../billing/plan-seams";
import { createR2SiteAssetStore } from "../site-assets/store";
import { createR2DocsContentStore, type R2DocsReadOptions } from "./store";
import type { DocsContentServiceDeps } from "./service";

export function createDocsContentDependencies(
  env: Env,
  options: R2DocsReadOptions = {},
): DocsContentServiceDeps {
  return {
    store: createR2DocsContentStore(env.DOCS_BUCKET, options),
    branches: new DocsBranchesRepository(env),
    entitlements: planSeamsFromEnv(env).entitlements,
    assets: createR2SiteAssetStore(env.DOCS_BUCKET),
    analytics: productAnalyticsOf(env),
  };
}
