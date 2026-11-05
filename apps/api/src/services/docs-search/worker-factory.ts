import { resolveProductionDocsAccessPolicy } from "../docs-access";
import { createR2DocsContentStore } from "../docs-content/store";
import { DocsSearchIndexesRepository } from "../../repositories/docs-search-indexes";
import { isDocsPreviewGateEnabled, type Env } from "../../env";
import { DocsSearchIndexWorker } from "./index-worker";
import { createSearchPolicyService } from "./policy";
import { createDocsSearchWriters } from "./providers";

export function createDocsSearchIndexWorker(env: Env): DocsSearchIndexWorker {
  const store = createR2DocsContentStore(env.DOCS_BUCKET);
  const accessPolicy = resolveProductionDocsAccessPolicy({
    gateEnabled: isDocsPreviewGateEnabled(env.DOCS_PREVIEW_GATE_ENABLED),
  });
  return new DocsSearchIndexWorker({
    tasks: new DocsSearchIndexesRepository(env),
    policy: createSearchPolicyService(env),
    writers: createDocsSearchWriters(env),
    read: (key) => store.read(key),
    isPublic: accessPolicy === "public",
  });
}
