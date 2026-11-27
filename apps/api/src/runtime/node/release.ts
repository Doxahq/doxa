import { RELEASE_HEADER } from "@doxahq/api-bridge";

/**
 * The release of this origin (DOXA_RELEASE_ID), on every response. The
 * release's smoke check reads it on api.doxa.so to prove that the edge
 * serves the new origin color.
 */
export function withReleaseHeader(response: Response, releaseId: string): Response {
  const released = new Response(response.body, response);
  released.headers.set(RELEASE_HEADER, releaseId);
  return released;
}

/**
 * Logs a keyed request from an edge of another release, once per edge
 * release. During a release flip, the edge and the origin switch within
 * seconds of each other, so a few lines are normal; a mismatch that keeps
 * coming means that one side did not switch. Only the edge holds the origin
 * key, so the set of releases stays small.
 */
export function createReleaseMismatchLog(releaseId: string, warn: (message: string) => void = console.warn) {
  const reported = new Set<string>();
  return (request: Request): void => {
    const edgeRelease = request.headers.get(RELEASE_HEADER) ?? "(none)";
    if (edgeRelease === releaseId || reported.has(edgeRelease)) return;
    reported.add(edgeRelease);
    warn(`Release mismatch: the edge runs ${edgeRelease}, this origin runs ${releaseId}.`);
  };
}
