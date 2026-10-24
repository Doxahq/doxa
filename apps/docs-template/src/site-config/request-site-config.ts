import type { DocsRequestContext } from "../runtime/request-context";
import { createConfiguredRuntimeSource } from "../runtime/runtime-source-selection";
import { loadSiteConfig } from "./load-site-config";

export async function requestSiteConfig(context: DocsRequestContext = {}) {
  return (
    context.siteConfig ??
    loadSiteConfig(
      context.runtimeSource ?? (await createConfiguredRuntimeSource())
    )
  );
}
