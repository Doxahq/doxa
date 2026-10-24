import { handleDocsResolverRequest } from "./http/docs-resolver";
import { DocsRepository } from "./repositories/docs";
import {
  resolveDocsHost,
  type DocsResolutionEnv,
} from "./services/docs-host-resolution";

// A separate default fetch handler is required: placement ignores named RPC.
// Share the API repositories instead of maintaining a second set of SQL rules.
export default {
  fetch(request: Request, env: DocsResolutionEnv): Promise<Response> {
    return handleDocsResolverRequest(request, {
      resolveDocsHost: (hostname) => resolveDocsHost(env, hostname),
      resolveDocsProject: (projectId) =>
        new DocsRepository(env).resolveByProjectId(projectId),
      resolveDocsSite: (slug) => new DocsRepository(env).resolveBySlug(slug),
    });
  },
} satisfies ExportedHandler<DocsResolutionEnv>;
