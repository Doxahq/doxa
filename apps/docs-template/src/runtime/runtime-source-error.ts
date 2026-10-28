export class RuntimeSourceError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "RuntimeSourceError";
  }
}

/**
 * The content runtime's code for a hostname or project without published
 * docs. The runtime answers it as a 404.
 */
const NO_PUBLISHED_DOCS_CODE = "project_not_found";

/** True when the content runtime has no published docs for the request. */
export function isNoPublishedDocsError(error: unknown): boolean {
  return (
    error instanceof RuntimeSourceError && error.code === NO_PUBLISHED_DOCS_CODE
  );
}
