import type { ApiContext } from "./app";

export function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** The `:projectId` route parameter; empty when the route has none. */
export function projectIdParam(context: ApiContext): string {
  return context.req.param("projectId") ?? "";
}
