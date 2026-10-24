import type { ProjectAnalysis, RestApiReferenceSurface } from "../types";

/**
 * The analysis with a REST surface that code built. The endpoint list and
 * `hasApiRoutes` follow the surface, so the planner prompt agrees with the
 * pages.
 */
export function withRestSurface(analysis: ProjectAnalysis, surface: RestApiReferenceSurface): ProjectAnalysis {
  const apiEndpoints = surface.groups.flatMap((group) =>
    group.endpoints.map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      description: endpoint.title || endpoint.description,
    }))
  );
  return {
    ...analysis,
    hasApiRoutes: apiEndpoints.length > 0 || analysis.hasApiRoutes,
    apiEndpoints,
    publicInterfaces: { ...analysis.publicInterfaces, apiEndpoints },
    referenceSurfaces: { ...analysis.referenceSurfaces, rest: surface },
  };
}
